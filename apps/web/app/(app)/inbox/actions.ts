"use server";

import { revalidatePath } from "next/cache";
import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  sendJobId,
} from "@whatsapp-os/core/queues";
import {
  fillVariables,
  templateVariables,
} from "@whatsapp-os/core/whatsapp";
import {
  advanceConversation,
  canSend,
  clearNeedsHuman,
  handOff,
  withCompany,
} from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { systemQueue } from "@/lib/queue";
import { refusalSentence, retryOffer } from "@/lib/thread-display";

/**
 * Write the message, then enqueue it. Nothing here talks to Meta.
 *
 * The split is the phase's central decision and Phase 5's bulk queue reuses
 * this half unchanged: the composer persists a PENDING row and hands the id to
 * a worker, which is the only thing that calls /messages. A send that went out
 * from the action would put a network round trip inside a request the operator
 * is waiting on, and - far worse - would leave a message that Meta accepted
 * with no row to attach the wamid to if the response were lost.
 */

export interface SendState {
  error?: string;
  /** Cleared on success so the textarea empties. Echoed back on failure. */
  draft?: string;
}

/** Meta's own ceiling for a text body. Refused here rather than by Meta. */
const MAX_BODY_LENGTH = 4096;

export async function sendMessageAction(
  _previous: SendState,
  formData: FormData,
): Promise<SendState> {
  /* Its own check, not the layout's — rule 4. */
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  const conversationId = String(formData.get("conversationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!conversationId) return { error: "Something went wrong. Try again." };
  if (body.length === 0) return { error: "Write something first." };
  if (body.length > MAX_BODY_LENGTH) {
    return {
      draft: body,
      error: `WhatsApp allows ${MAX_BODY_LENGTH} characters and this is ${body.length}.`,
    };
  }

  /*
   * One instant for the check and the row, so a window cannot close between
   * deciding this is allowed and recording when it happened.
   */
  const now = new Date();

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    /*
     * canSend here is feedback, not the boundary. The worker runs it again
     * immediately before the Graph call and that one is authoritative - by the
     * time a queue has been through, this answer is seconds to minutes old and
     * the 24-hour window may have closed inside the gap. Both exist on purpose;
     * removing this one would mean the operator learns from a red bubble
     * instead of from the composer.
     */
    const sendability = await canSend(
      db,
      companyId,
      conversationId,
      { kind: "freeform" },
      now,
    );

    /* Rule 6: a thread that is not yours does not exist. */
    if (!sendability) return { kind: "gone" } as const;

    if (!sendability.decision.allowed) {
      return { kind: "refused", reason: sendability.decision.reason } as const;
    }

    const message = await db.message.create({
      data: {
        companyId,
        conversationId,
        direction: "OUTBOUND",
        status: "PENDING",
        type: "text",
        body,
        /* Ours, because Meta has not seen this yet. The thread orders on it. */
        occurredAt: now,
        sentByUserId: session.userId,
        sendAttempt: 0,
      },
      select: { id: true, sendAttempt: true },
    });

    /*
     * The thread and the inbox both move now rather than when Meta answers.
     * windowExpiresAt is null: an outbound message never opens or extends a
     * window - only the customer writing does - and passing a value here would
     * hand somebody a way to reopen their own 24 hours by talking.
     */
    await advanceConversation(db, companyId, conversationId, {
      occurredAt: now,
      preview: body,
      inbound: false,
      windowExpiresAt: null,
      unread: 0,
    });

    return { kind: "created", message } as const;
  });

  if (outcome.kind === "gone") {
    return { draft: body, error: "This conversation is no longer available." };
  }

  if (outcome.kind === "refused") {
    return { draft: body, error: refusalSentence(outcome.reason) };
  }

  /*
   * Outside the scope. withCompany holds a pooled connection and times out at
   * 5s, and Redis being slow is not a reason to lose a transaction that has
   * already written the row.
   */
  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    {
      companyId: session.companyId,
      messageId: outcome.message.id,
      sendAttempt: outcome.message.sendAttempt,
    },
    {
      jobId: sendJobId(outcome.message.id, outcome.message.sendAttempt),
      ...SEND_JOB_OPTIONS,
    },
  );

  /*
   * A person has taken over, so the flow stops.
   *
   * -------------------------------------------------------------------------
   * Two writers on one conversation is the failure this prevents
   * -------------------------------------------------------------------------
   *
   * A flow run standing in this thread is waiting for a tap. Without this, an
   * operator answers the customer in their own words, the customer then taps
   * the button that was still sitting above it, and the flow carries straight
   * on - asking its next question over the top of a conversation a person is
   * now having. Both sides are talking, neither knows about the other, and the
   * customer is the only one who can see both.
   *
   * Handed off rather than failed or paused, because that is what has actually
   * happened: the automation stopped because a human took the thread. It is
   * also what the thread's own banner promises, and a promise the product does
   * not keep would be worse than no banner at all.
   *
   * After the enqueue and deliberately outside the transaction above: the
   * message going out is the point of the action, and a run that could not be
   * handed off must not lose the operator's reply.
   */
  await handOffFlowRun(session.companyId, conversationId);

  /* The action stays on the page, so nothing re-renders without this. */
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");

  return {};
}

/**
 * End whatever flow is standing in this conversation, if one is.
 *
 * Reads first so that the ordinary case - no flow, which is most threads - is
 * one indexed lookup and no write at all.
 */
async function handOffFlowRun(
  companyId: string,
  conversationId: string,
): Promise<void> {
  const run = await withCompany(companyId, (db) =>
    db.flowRun.findFirst({
      where: { activeConversationId: conversationId },
      select: { id: true },
    }),
  );

  if (!run) return;

  /*
   * false: this handoff records that a person has ALREADY arrived, so the
   * thread must not be flagged as needing one. See handOff - its two callers
   * mean opposite things, and flagging here would put a request for a person
   * into the queue in front of the person who just took the thread.
   */
  await handOff(
    companyId,
    run.id,
    "Someone from the team replied, so the flow stopped here.",
    false,
  );
}

/* ------------------------------------------------------------------------- *
 * Retry
 * ------------------------------------------------------------------------- */

export interface RetryState {
  error?: string;
}

/**
 * Ask for one message to be handed to Meta again.
 *
 * R2 in one line: `sendAttempt` increments on the row AND rides in the job id.
 * BullMQ keeps completed job ids for an hour and failed ones for a day and
 * refuses a job whose id it already holds - silently, because for every other
 * job here that refusal is the deduplication. Re-enqueueing under the first
 * attempt's id would drop this on the floor and the button would appear dead.
 *
 * The increment and the enqueue are deliberately in that order. If the update
 * lands and the enqueue fails, the operator presses again and gets a fresh
 * attempt number and a fresh id; if the enqueue happened first it could be
 * refused as a duplicate of an attempt the row never recorded.
 *
 * canSend is not re-run here. It runs in the worker immediately before the
 * Graph call and that is the boundary - a retry that the window has closed on
 * comes back as a POLICY failure with a sentence, which is the same answer the
 * composer would have given a second earlier and one fewer place to disagree.
 */
export async function retryMessageAction(
  _previous: RetryState,
  formData: FormData,
): Promise<RetryState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  const messageId = String(formData.get("messageId") ?? "");
  if (!messageId) return { error: "Something went wrong. Try again." };

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    const message = await db.message.findFirst({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        status: true,
        wamid: true,
        sendAttempt: true,
      },
    });

    /* Rule 6: not yours means it does not exist. */
    if (!message) return { kind: "gone" } as const;

    /*
     * The same decision the bubble rendered, asked again on the server.
     *
     * The button is only drawn for a retryable message, so reaching here with
     * anything else is a stale page or a hand-made POST - and the dangerous one
     * is a message that has since been given a wamid, where a second POST would
     * reach a real customer twice.
     */
    if (!retryOffer(message.status, message.wamid !== null)) {
      return { kind: "not_retryable" } as const;
    }

    const updated = await db.message.update({
      where: { id: message.id },
      data: {
        sendAttempt: { increment: 1 },
        status: "PENDING",
        /* Cleared, because they describe the previous attempt. A bubble that
           has gone back to Sending must not still carry last time's reason. */
        errorSource: null,
        errorCode: null,
        errorTitle: null,
      },
      select: { id: true, conversationId: true, sendAttempt: true },
    });

    return { kind: "queued", message: updated, companyId } as const;
  });

  if (outcome.kind === "gone") {
    return { error: "That message is no longer available." };
  }

  if (outcome.kind === "not_retryable") {
    return { error: "That message cannot be sent again." };
  }

  /* Outside the scope: Redis is not worth a held connection or a lost write. */
  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    {
      companyId: session.companyId,
      messageId: outcome.message.id,
      sendAttempt: outcome.message.sendAttempt,
    },
    {
      jobId: sendJobId(outcome.message.id, outcome.message.sendAttempt),
      ...SEND_JOB_OPTIONS,
    },
  );

  revalidatePath(`/inbox/${outcome.message.conversationId}`);
  revalidatePath("/inbox");

  return {};
}

/* ------------------------------------------------------------------------- *
 * Templates
 * ------------------------------------------------------------------------- */

/**
 * Send an approved template, which is the one thing allowed once the window
 * has closed.
 *
 * Same shape as the free-form send and for the same reasons: canSend here is
 * feedback and the worker's is the boundary, the row is written PENDING, and
 * Redis is touched outside the scope. What differs is the intent - asked as
 * `template`, because a template asked as free-form would be refused by the
 * very window it exists to survive.
 */
export async function sendTemplateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  const conversationId = String(formData.get("conversationId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");
  if (!conversationId || !templateId) return;

  const now = new Date();

  const created = await withCompany(session.companyId, async (db, companyId) => {
    const template = await db.whatsAppTemplate.findFirst({
      where: { id: templateId },
      select: { id: true, name: true, language: true, status: true, components: true },
    });

    /* Rule 6, and the approval check together: a template that is not yours
       does not exist, and one that is not approved cannot be sent. */
    if (!template) return null;

    const sendability = await canSend(
      db,
      companyId,
      conversationId,
      { kind: "template", approved: template.status === "APPROVED" },
      now,
    );

    if (!sendability || !sendability.decision.allowed) return null;

    /*
     * Parameters in Meta's own order. templateVariables returns them sorted, so
     * index 0 is {{1}} - the same ordering the picker collected them in and the
     * same one Meta matches positionally. Getting this out of order would put
     * the order number where the customer's name goes.
     */
    const body = extractBody(template.components);
    const parameters = templateVariables(body).map((n) =>
      String(formData.get(`parameter_${n}`) ?? ""),
    );

    const message = await db.message.create({
      data: {
        companyId,
        conversationId,
        direction: "OUTBOUND",
        status: "PENDING",
        type: "template",
        /* The body as the customer will read it, so the thread shows the
           message rather than a template name. The payload below is what
           actually goes to Meta. */
        body: fillVariables(body, parameters),
        templatePayload: {
          name: template.name,
          language: template.language,
          parameters,
        },
        occurredAt: now,
        sentByUserId: session.userId,
        sendAttempt: 0,
      },
      select: { id: true, sendAttempt: true },
    });

    await advanceConversation(db, companyId, conversationId, {
      occurredAt: now,
      preview: fillVariables(body, parameters),
      inbound: false,
      /* A template does not open a window either. Only the customer writing
         does, which is the rule the whole 24 hours rests on. */
      windowExpiresAt: null,
      unread: 0,
    });

    return message;
  });

  if (!created) return;

  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    {
      companyId: session.companyId,
      messageId: created.id,
      sendAttempt: created.sendAttempt,
    },
    {
      jobId: sendJobId(created.id, created.sendAttempt),
      ...SEND_JOB_OPTIONS,
    },
  );

  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
}

/** The BODY text out of a stored component array, or empty if there is none. */
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as { type?: unknown }).type === "BODY" &&
      typeof (component as { text?: unknown }).text === "string"
    ) {
      return (component as { text: string }).text;
    }
  }
  return "";
}

/* ------------------------------------------------------------------------- *
 * Taking a thread
 * ------------------------------------------------------------------------- */

/**
 * Assign this conversation to whoever pressed the button, and clear the flag.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * `conversations.assigned_user_id` has been in the schema since Phase 1 and
 * until now nothing ever wrote it. Every read treated null as "nobody has
 * picked this up", which was true by construction because there was no way to
 * pick anything up.
 *
 * That was survivable while the signal was derived from an unread count -
 * reading the thread cleared it, so the queue drained by itself. It stops being
 * survivable the moment a flag persists until somebody clears it deliberately,
 * which is the whole point of the flag: a queue with no way to take a thread
 * off it is a list that only grows.
 *
 * ---------------------------------------------------------------------------
 * Assignment is what clears it, and reading is not
 * ---------------------------------------------------------------------------
 *
 * Deliberately not wired into the thread page's render. Opening a conversation
 * is how somebody decides whether they want it, and a queue that emptied on
 * being looked at is the exact bug `needs_human_at` replaced - one glance from
 * anybody and the request was gone.
 *
 * Taking it is a decision, so it is a button.
 */
export async function takeConversationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const conversationId = String(formData.get("conversationId") ?? "");
  if (!conversationId) return;

  await withCompany(session.companyId, async (db, companyId) => {
    /*
     * updateMany, not update: the extension merges companyId - a non-unique
     * column - into `where`, which update's where type does not accept. It
     * also means a conversation belonging to another company matches nothing
     * and silently does nothing, which is rule 6 rather than a 404 that would
     * confirm the id exists.
     */
    const touched = await db.conversation.updateMany({
      where: { id: conversationId, companyId },
      data: { assignedUserId: session.userId, assignedAt: new Date() },
    });

    if (touched.count === 0) return;

    await clearNeedsHuman(db, companyId, conversationId);
  });

  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
  /* The dashboard's waiting-for-a-human card reads the same predicate. */
  revalidatePath("/dashboard");
}

/**
 * Put it back on the queue.
 *
 * The counterpart, and it is not symmetrical: releasing a thread clears the
 * assignment but does NOT re-flag it. Whoever took it may have finished, and
 * re-raising the request every time somebody let go would make the queue
 * un-emptiable. Something has to decide a person is needed, and this is not
 * that decision.
 */
export async function releaseConversationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const conversationId = String(formData.get("conversationId") ?? "");
  if (!conversationId) return;

  await withCompany(session.companyId, (db, companyId) =>
    db.conversation.updateMany({
      where: { id: conversationId, companyId },
      data: { assignedUserId: null, assignedAt: null },
    }),
  );

  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");
}
