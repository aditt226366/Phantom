import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  sendJobId,
  type VerseReplyJob,
} from "@whatsapp-os/core/queues";
import { usageDedupeKey } from "@whatsapp-os/core";
import {
  SIMILARITY_FLOOR,
  VERSE_MODELS,
  anthropicRouter,
  buildSystemPrompt,
  escalationBefore,
  googleRouter,
  groundingFor,
  handoffMessage,
  handoffReason,
  openaiEmbeddingRouter,
  openaiRouter,
  turnsFrom,
  type ModelRouter,
  type VerseTier,
} from "@whatsapp-os/core/verse";
import {
  canSend,
  flagNeedsHuman,
  materialiseFlowMessage,
  recordUsage,
  releaseDriver,
  retrieveChunks,
  verseContextFor,
  withCompany,
} from "@whatsapp-os/db";
import { env } from "../env.ts";
import { log } from "../logger.ts";
import { systemQueue } from "../queue.ts";

/**
 * One customer message in, one reply or one handoff out.
 *
 * ---------------------------------------------------------------------------
 * The order of the checks is the design
 * ---------------------------------------------------------------------------
 *
 *   1. is this Verse's conversation at all      driver, read at answer time
 *   2. is the window open                       BEFORE any model call
 *   3. does the knowledge base answer it        the floor
 *   4. should a person handle it anyway         escalation
 *   5. only then, generate
 *
 * Two of those orderings cost money if reversed.
 *
 * The WINDOW is checked before the model, not after. A reply generated for a
 * conversation that cannot receive it is a provider bill for text nobody will
 * read - and the temptation to generate first and check later is real, because
 * the code reads more naturally that way.
 *
 * ESCALATION is decided before the model too, so a refund question never
 * reaches a model at all. Deciding afterwards would mean paying to generate an
 * answer we have already resolved not to send, and - worse - having that
 * answer sitting in a log where somebody could later decide to use it.
 */

function routerFor(tier: VerseTier): ModelRouter | null {
  const model = VERSE_MODELS[tier];
  const key =
    tier === "V1"
      ? env.VERSE_V1_API_KEY
      : tier === "V2"
        ? env.VERSE_V2_API_KEY
        : env.VERSE_V3_API_KEY;

  if (!key) return null;

  switch (model.provider) {
    case "anthropic":
      return anthropicRouter(fetch, key);
    case "google":
      return googleRouter(fetch, key);
    case "openai":
      return openaiRouter(fetch, key);
  }
}

function isTier(value: string): value is VerseTier {
  return value === "V1" || value === "V2" || value === "V3";
}

export async function handleVerseReply(job: VerseReplyJob): Promise<void> {
  const { companyId, conversationId, messageId } = job;
  const now = new Date();

  const context = await withCompany(companyId, (db, scoped) =>
    verseContextFor(db, scoped, conversationId),
  );

  /*
   * Not Verse's conversation. The ordinary outcome of a customer replying to a
   * thread a person has since taken over, so it is info and not a warning.
   */
  if (!context) {
    /* The inbound message id is carried into the log so a support question -
       "why did the bot not answer this" - is answerable from one line. */
    log.info("verse.reply: not driving this conversation", {
      conversationId,
      messageId,
    });
    return;
  }

  /* ---------------------------------------------------------------------- *
   * The window, before anything is generated
   * ---------------------------------------------------------------------- */

  const sendability = await withCompany(companyId, (db, scoped) =>
    canSend(db, scoped, conversationId, { kind: "freeform" }, now),
  );

  if (!sendability) return;

  if (!sendability.decision.allowed) {
    /*
     * Outside the window - or refused for a workspace reason - nothing
     * free-form may go out. Verse does NOT fall back to sending a template
     * here: the campaign's approved template is an OPENER, and firing it at
     * somebody mid-conversation because their window lapsed would restart the
     * conversation rather than continue it.
     *
     * Re-opening a lapsed conversation is the campaign engine's job, on the
     * campaign's own schedule and against its daily cap. This path just stops.
     */
    log.info("verse.reply: cannot send", {
      conversationId,
      reason: sendability.decision.reason,
    });
    return;
  }

  /* ---------------------------------------------------------------------- *
   * Retrieve
   * ---------------------------------------------------------------------- */

  const question = [...context.history]
    .reverse()
    .find((message) => message.inbound && message.body)?.body;

  if (!question) return;

  const embeddingKey = env.VERSE_EMBEDDING_API_KEY;
  const router = isTier(context.modelTier) ? routerFor(context.modelTier) : null;

  /*
   * No credential is an ESCALATION, not a silent stop.
   *
   * A customer has asked a question and is waiting. Doing nothing leaves them
   * waiting for ever with nobody told; handing over gets a person to them and
   * puts the reason in front of an operator, who is the only one who can
   * escalate it further.
   */
  if (!embeddingKey || !router) {
    await handOver(
      companyId,
      context,
      "model_refused",
      now,
      "Verse is not configured on this server: a model or embedding " +
        "credential is missing.",
    );
    return;
  }

  const embedded = await openaiEmbeddingRouter(fetch, embeddingKey).embed([
    question,
  ]);

  if (embedded.kind === "failed") {
    await handOver(companyId, context, "model_refused", now, embedded.reason);
    return;
  }

  const chunks = await withCompany(companyId, (db, scoped) =>
    retrieveChunks(db, scoped, {
      knowledgeBaseId: context.knowledgeBaseId,
      embedding: embedded.vectors[0]!,
    }),
  );

  const grounding = groundingFor(chunks, SIMILARITY_FLOOR);

  /* ---------------------------------------------------------------------- *
   * Escalate, or answer
   * ---------------------------------------------------------------------- */

  const turnsWithoutProgress = countVerseTurnsSinceCustomerProgress(
    context.history,
  );

  const escalation = escalationBefore({
    message: question,
    grounded: grounding.kind === "grounded",
    turnsWithoutProgress,
  });

  if (escalation) {
    await handOver(companyId, context, escalation, now);
    return;
  }

  if (grounding.kind !== "grounded") {
    /* Unreachable - escalationBefore returns no_grounding first - and written
       anyway, because the type is what stops a later edit reaching the model
       with an empty passage block. */
    await handOver(companyId, context, "no_grounding", now);
    return;
  }

  const outcome = await router.complete({
    system: buildSystemPrompt({
      goal: context.goal,
      businessName: context.businessName,
      chunks: grounding.chunks,
    }),
    turns: turnsFrom(context.history),
    maxOutputTokens: 512,
  });

  if (outcome.kind !== "answered") {
    await handOver(
      companyId,
      context,
      "model_refused",
      now,
      outcome.kind === "refused" ? outcome.reason : undefined,
    );
    return;
  }

  /* ---------------------------------------------------------------------- *
   * Send it, through the one send path
   * ---------------------------------------------------------------------- */

  const sent = await withCompany(companyId, async (db, scoped) => {
    const message = await materialiseFlowMessage(db, scoped, {
      conversationId,
      contactId: context.contactId,
      renderedBody: outcome.text,
      /* Plain text. Verse has no buttons - it answers in words. */
      interactive: null,
      occurredAt: new Date(),
    });

    if (!message) return null;

    /*
     * Deduped on OUR message id, and recorded here rather than at the Graph
     * call: this charge is for the MODEL call, which has already happened and
     * cost money whether or not Meta accepts the message.
     *
     * The job runs with the default five attempts, so without the dedupe a job
     * that records usage and then fails on the enqueue would charge five times
     * for one answer.
     */
    await recordUsage(db, scoped, {
      kind: "verse.reply",
      dedupeKey: usageDedupeKey("verse.reply", message.messageId),
      occurredAt: now,
    });

    return message;
  });

  if (!sent) {
    /* The contact opted out between the question and the answer. Not an error
       - they have left, and materialiseFlowMessage returning null is how it
       says so without writing a message row nobody can explain. */
    return;
  }

  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    { companyId, messageId: sent.messageId, sendAttempt: sent.sendAttempt },
    { ...SEND_JOB_OPTIONS, jobId: sendJobId(sent.messageId, sent.sendAttempt) },
  );

  log.info("verse.reply: answered", {
    conversationId,
    messageId: sent.messageId,
    chunks: grounding.chunks.length,
    best: grounding.chunks[0]?.similarity,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
  });
}

/**
 * Hand the conversation to a person, and stop driving it.
 *
 * ---------------------------------------------------------------------------
 * Three writes, and the order matters
 * ---------------------------------------------------------------------------
 *
 * The flag goes first, so a crash between the writes leaves a thread that is
 * flagged for a person and still shows Verse as its driver - which an operator
 * can act on. The reverse order leaves a released thread with nobody told,
 * which is a customer waiting with no queue entry.
 *
 * flagNeedsHuman is the FOURTH caller: an unread inbound, a flow's handoff
 * node, a flow action's notify, and now this. It is a state column rather than
 * a derivation precisely because it has more than one source - deriving it
 * from unread counts was correct with one writer and silently wrong with two.
 *
 * The driver is released so an operator replying does not have to displace
 * anything, and so the thread is not left looking automated when it is not.
 */
async function handOver(
  companyId: string,
  context: { conversationId: string; contactId: string },
  reason: Parameters<typeof handoffReason>[0],
  at: Date,
  detail?: string,
): Promise<void> {
  await withCompany(companyId, async (db, scoped) => {
    await flagNeedsHuman(db, scoped, context.conversationId, {
      reason: detail
        ? `${handoffReason(reason)} (${detail})`
        : handoffReason(reason),
      at,
    });
  });

  /*
   * The customer is told, in words that name no machinery.
   *
   * Sent through the same producer as an answer, so it is an ordinary message
   * row in the thread rather than a special case the inbox has to know about.
   * A handoff the customer never sees is a person arriving into a conversation
   * with no explanation of the gap.
   */
  const sent = await withCompany(companyId, (db, scoped) =>
    materialiseFlowMessage(db, scoped, {
      conversationId: context.conversationId,
      contactId: context.contactId,
      renderedBody: handoffMessage(reason),
      interactive: null,
      occurredAt: at,
    }),
  );

  if (sent) {
    await systemQueue.add(
      JOB_NAMES.WHATSAPP_MESSAGE_SEND,
      { companyId, messageId: sent.messageId, sendAttempt: sent.sendAttempt },
      {
        ...SEND_JOB_OPTIONS,
        jobId: sendJobId(sent.messageId, sent.sendAttempt),
      },
    );
  }

  /*
   * Released LAST, and through the ordinary path rather than by writing the
   * column here - releaseDriver clears the instant with it, which the CHECK
   * requires.
   */
  await withCompany(companyId, (db, scoped) =>
    releaseDriver(db, scoped, context.conversationId),
  );

  log.info("verse.reply: handed over", {
    conversationId: context.conversationId,
    reason,
  });
}

/**
 * How many times Verse has answered since the customer last said something new.
 *
 * Counts consecutive outbound messages at the end of the thread. Crude, and
 * crude in the right direction: a customer who has replied is making progress
 * by definition, and one who is watching the same answer arrive three times is
 * not - whatever the words are.
 *
 * Deliberately not a similarity comparison between successive customer
 * messages. That would be a second, unmeasured threshold doing the job of the
 * one this phase already cannot measure.
 */
export function countVerseTurnsSinceCustomerProgress(
  history: ReadonlyArray<{ inbound: boolean; body: string | null }>,
): number {
  let count = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.inbound) break;
    count += 1;
  }

  return count;
}
