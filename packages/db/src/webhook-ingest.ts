import {
  parseWebhookPayload,
  windowExpiryFor,
  type InboundMessage,
  type SkippedChange,
  type StatusUpdate,
} from "@whatsapp-os/core/whatsapp";
import {
  advanceConversation,
  applyStatusUpdate,
  type StatusOutcome,
} from "./conversations.ts";
import { recordConversationCharge } from "./conversation-charges.ts";
import { applyTemplateStatus } from "./templates.ts";
import { markWebhookProcessed } from "./webhook-events.ts";
import { withCompany, type CompanyClient } from "./with-company.ts";

/**
 * Turn one recorded webhook delivery into contacts, conversations and messages.
 *
 * ---------------------------------------------------------------------------
 * Why this returns media requests instead of fetching anything
 * ---------------------------------------------------------------------------
 *
 * An inbound media message carries an id, not bytes. Getting the bytes is a
 * Graph call, and the ingest path must never make one: it runs inside
 * withCompany, a scope holds a pooled connection, and Prisma abandons it after
 * five seconds while Meta does not care. That is R7 - a webhook burst is a pool
 * problem - and it is the whole reason the endpoint records and returns rather
 * than processing inline.
 *
 * So the fetch is a separate job, and this function cannot enqueue it. It
 * returns the requests and the caller enqueues them after every scope has
 * closed. Written that way deliberately: "do not make a network call in here"
 * is a rule somebody eventually breaks, and a function with no queue in scope
 * is a rule nobody can break.
 */

export interface MediaFetchRequest {
  messageId: string;
  /** Meta's media id. Its download URL expires in minutes. */
  metaMediaId: string;
}

/**
 * An inbound message that might move a flow, for the caller to act on.
 *
 * Collected here and advanced by the caller, exactly like the media requests
 * above and for the same reason: advancing a flow sends messages, and this
 * function must not enqueue anything while a company scope is open.
 *
 * Only messages that could possibly matter are collected - a tap of any kind,
 * or a typed reply in a conversation that has a run waiting on it. The
 * alternative, handing every inbound text to the engine, would be a job per
 * customer message across every tenant for the sake of the handful that are
 * answering a collect node.
 */
/**
 * An inbound message Verse should answer, for the caller to act on.
 *
 * Collected here and enqueued by the caller, exactly like the media and flow
 * requests above and for the same reason: answering sends messages, and this
 * function must not enqueue anything while a company scope is open.
 *
 * Gated on the conversation's DRIVER rather than on the existence of a
 * campaign. A thread an operator has taken over is not Verse's to answer even
 * though its campaign is still running, and the driver is the one column that
 * knows that. The handler re-reads it anyway - time passes between here and
 * there - but collecting on it keeps a job per customer message from being
 * enqueued for every thread of every campaign that a person is handling.
 */
export interface VerseReplyRequest {
  conversationId: string;
  messageId: string;
}

export interface FlowAdvanceRequest {
  conversationId: string;
  messageId: string;
  /** The button or list-row id, when the customer tapped one. */
  replyId: string | null;
  text: string | null;
  occurredAt: Date;
}

/**
 * Why some part of a delivery was not applied. Codes, never prose - they end up
 * in whatsapp_webhook_events.skipped_reason and in the operator counts commit
 * 26 puts on the admin Overview, and a reworded sentence would silently stop
 * matching there.
 *
 * Three sources, kept in one union so the caller has one thing to switch on:
 * the parser's own reasons, this file's, and the ladder's verdicts.
 */
export type IngestSkipReason =
  | SkippedChange["reason"]
  | "unparseable_payload"
  | "company_deactivated"
  | "unknown_phone_number_id"
  | `status_${StatusOutcome}`;

export interface IngestSummary {
  status: "processed" | "skipped" | "already_processed" | "unknown_event";
  /** Messages in the payload, whether or not they were new. */
  messages: number;
  /** Messages actually inserted. Lower on a redelivery, and that is correct. */
  inserted: number;
  statuses: number;
  /** Status callbacks that moved a message up the ladder. */
  advanced: number;
  /**
   * Conversation windows charged by this delivery.
   *
   * Counted separately from `advanced` because the two are independent: a
   * status for a wamid we have no row for advances nothing and can still carry
   * a billable window, which is the case a bill reconciliation is about.
   */
  charges: number;
  /** Machine codes, never prose. Aggregated for the operator counts. */
  skipped: IngestSkipReason[];
  /** For the caller to enqueue, once it is no longer holding a scope. */
  media: MediaFetchRequest[];
  /** Inbound messages that might move a flow. Same rule as media above. */
  flowAdvances: FlowAdvanceRequest[];
  verseReplies: VerseReplyRequest[];
  /**
   * Meta said a number's quality or tier moved, so the cache is stale.
   *
   * A count rather than the payload's contents, deliberately: the refresh reads
   * the whole account from Meta and writes what comes back, so the notification
   * is a reason to look, not a thing to store. Enqueued by the caller, like the
   * media requests, once no scope is open.
   */
  numberQualityUpdates: number;
  /**
   * Template verdicts, applied rather than counted.
   *
   * The opposite of a quality update, and worth the contrast: that one is a
   * trigger, because Meta will tell us the whole truth about a number if we
   * ask. This one IS the truth - there is no cheap way to ask what happened to
   * one template - so the callback is written into the row here and the number
   * below is only how many landed on a template this system holds.
   *
   * A WABA also holds templates created in Business Manager that this system
   * has never seen, and Meta sends callbacks for those too. `unmatched` counts
   * them, and it is an ordinary number rather than an error.
   */
  templatesUpdated: number;
  templatesUnmatched: number;
}

function emptySummary(status: IngestSummary["status"]): IngestSummary {
  return {
    status,
    messages: 0,
    inserted: 0,
    statuses: 0,
    advanced: 0,
    charges: 0,
    skipped: [],
    media: [],
    flowAdvances: [],
    verseReplies: [],
    numberQualityUpdates: 0,
    templatesUpdated: 0,
    templatesUnmatched: 0,
  };
}

/**
 * Process one delivery, or explain why it was not processed.
 *
 * ---------------------------------------------------------------------------
 * The event is marked processed once, at the end, and never per message
 * ---------------------------------------------------------------------------
 *
 * One delivery can carry several messages. If the second one fails, processedAt
 * has to stay null so that Meta's redelivery - or a retry of this job - runs
 * the whole delivery again, including the messages that did succeed.
 *
 * That is only safe because of the unique on (company_id, wamid). Re-running a
 * delivery re-attempts every message in it, and the ones already inserted
 * conflict and are skipped rather than duplicated: the customer does not get a
 * second copy of their message in the thread, and the conversation's unread
 * count is not incremented twice, because the advance is conditional on the
 * insert having actually happened.
 *
 * Worth stating plainly, because "on failure we reprocess the whole delivery"
 * reads as a bug on its own. Without the unique it would be one. With it, the
 * choice is between reprocessing a delivery whose second half failed and losing
 * a customer message permanently, and it is not close.
 *
 * Marking per message would mean the same thing as marking up front: the
 * moment the row says processed, Meta's retry is discarded, and whatever had
 * not been written yet is gone with it.
 */
export async function ingestWebhookDelivery(
  companyId: string,
  eventId: string,
): Promise<IngestSummary> {
  const event = await withCompany(companyId, (db) =>
    db.whatsAppWebhookEvent.findFirst({
      where: { id: eventId },
      select: {
        id: true,
        payload: true,
        processedAt: true,
        company: { select: { deactivatedAt: true } },
      },
    }),
  );

  /* Not ours, or deleted by retention. Nothing to do and nothing to fail. */
  if (!event) return emptySummary("unknown_event");

  let body: unknown;
  try {
    body = JSON.parse(event.payload);
  } catch {
    /*
     * Unparseable, which for a stored body means it was truncated at the 64 KiB
     * cap. Reprocessing cannot fix that, so this is marked processed rather
     * than left to retry for ever - the raw payload stays on the row for
     * whoever asks why.
     */
    await withCompany(companyId, (db) =>
      markWebhookProcessed(db, companyId, eventId, {
        skippedReason: "unparseable_payload",
      }),
    );
    return { ...emptySummary("skipped"), skipped: ["unparseable_payload"] };
  }

  const parsed = parseWebhookPayload(body);
  const skipped: IngestSkipReason[] = parsed.skipped.map((entry) => entry.reason);

  /*
   * A suspended workspace still receives. Resolution deliberately does not
   * check deactivated_at - refusing there would 404 Meta and burn toward the
   * subscription being disabled (C2) - so the decision lands here instead, and
   * is recorded rather than silent.
   */
  if (event.company.deactivatedAt !== null) {
    await withCompany(companyId, (db) =>
      markWebhookProcessed(db, companyId, eventId, {
        skippedReason: "company_deactivated",
      }),
    );
    return {
      ...emptySummary("skipped"),
      messages: parsed.messages.length,
      statuses: parsed.statuses.length,
      skipped: [...skipped, "company_deactivated"],
    };
  }

  /*
   * Already done, so nothing is re-inserted. The outstanding media is still
   * computed and returned: the previous run may have died between marking the
   * event processed and its caller enqueueing, and this is the only path that
   * would ever notice. Everything it finds is a row that exists with no bytes
   * attached, so re-enqueueing is idempotent by construction.
   */
  if (event.processedAt !== null) {
    return {
      ...emptySummary("already_processed"),
      messages: parsed.messages.length,
      statuses: parsed.statuses.length,
      media: await outstandingMedia(companyId, parsed.messages),
      /*
       * Deliberately zero. A refresh for this delivery was enqueued when it was
       * first processed, and re-enqueueing on every redelivery would turn one
       * of Meta's retries into a second Graph call for no new information.
       */
      numberQualityUpdates: 0,
    };
  }

  const numbers = new Map<string, string | null>();
  let inserted = 0;
  const media: MediaFetchRequest[] = [];
  const flowAdvances: FlowAdvanceRequest[] = [];
  const verseReplies: VerseReplyRequest[] = [];

  /*
   * Messages before statuses, and the order is load-bearing.
   *
   * One delivery can carry a message and a status for that same message - Meta
   * batches, and a message read the moment it arrives produces both. With
   * statuses first, applyStatusUpdate would find no row, return
   * no_such_message, and record a skipped reason for a message that is about to
   * be inserted two lines later. The status would then never be applied at all,
   * because nothing redelivers a callback we already answered 200 to.
   */
  for (const message of parsed.messages) {
    const numberId = await resolveNumber(companyId, numbers, message.phoneNumberId);

    if (!numberId) {
      /* A number this company does not have. Recorded, not thrown: it is a
         configuration fact, and failing the job would retry it for ever. */
      skipped.push("unknown_phone_number_id");
      continue;
    }

    const outcome = await withCompany(companyId, (db, scoped) =>
      ingestMessage(db, scoped, message, numberId),
    );

    if (outcome.inserted) inserted++;
    if (outcome.media) media.push(outcome.media);
    /*
     * Only on an insert. A redelivery of a tap must not advance the run a
     * second time - Meta redelivers freely, and the second advance would send
     * the next question again and move the position past an answer the
     * customer gave once.
     */
    if (outcome.flow) flowAdvances.push(outcome.flow);
    if (outcome.verse) verseReplies.push(outcome.verse);
  }

  let advanced = 0;
  let charges = 0;

  for (const status of parsed.statuses) {
    const outcome = await withCompany(companyId, (db, scoped) =>
      applyStatusUpdate(db, scoped, {
        wamid: status.wamid,
        status: status.status,
        occurredAt: status.occurredAt,
        ...(status.errors.length > 0 ? { error: readError(status) } : {}),
      }),
    );

    if (outcome === "advanced") advanced++;
    else skipped.push(`status_${outcome}`);

    /*
     * Meta's conversation charge, which this loop read and discarded for five
     * phases.
     *
     * Separate from the status ladder above and deliberately not conditional on
     * it: `applyStatusUpdate` returns "unmatched" for a wamid we have no message
     * row for - a send from another tool on the same number, or a row pruned -
     * and the WINDOW was still charged. Tying the charge to the ladder would
     * drop exactly the conversations nobody here can see, which is the half a
     * bill reconciliation is for.
     *
     * Its own scope rather than sharing the one above, because a charge that
     * throws must not roll back a status the customer's phone has already
     * shown - and recordConversationCharge is idempotent, so the redelivery
     * that follows a throw cannot double it.
     */
    if (status.conversationId) {
      const charge = await withCompany(companyId, (db, scoped) =>
        recordConversationCharge(db, scoped, {
          metaConversationId: status.conversationId!,
          category: status.category,
          pricingModel: status.pricingModel,
          billable: status.billable,
          wamid: status.wamid,
          occurredAt: status.occurredAt,
        }),
      );

      if (charge.usageRecorded) charges++;
    }
  }

  /*
   * Template verdicts. Applied here rather than enqueued, because unlike a
   * quality update this callback carries everything worth storing and there is
   * no cheap way to ask Meta about one template.
   */
  let templatesUpdated = 0;
  let templatesUnmatched = 0;

  for (const update of parsed.templateUpdates) {
    const applied = await withCompany(companyId, (db, scoped) =>
      applyTemplateStatus(db, scoped, {
        metaTemplateId: update.metaTemplateId,
        status: update.status,
        rejectedReason: update.reason,
        category: update.category,
        at: new Date(),
      }),
    );

    if (applied) templatesUpdated++;
    else templatesUnmatched++;
  }

  /*
   * Last, and only now. Every message in this delivery has been written or has
   * thrown; a throw leaves processedAt null and the whole delivery is re-run,
   * which the wamid unique makes safe.
   */
  await withCompany(companyId, (db) =>
    markWebhookProcessed(db, companyId, eventId, {
      /*
       * A reason only when nothing at all was applied. The column answers "why
       * was nothing done", so filling it on a delivery that inserted four
       * messages and skipped one unhandled field would misreport a normal
       * delivery as a skipped one.
       */
      ...(inserted === 0 && advanced === 0 && skipped.length > 0
        ? { skippedReason: skipped[0] }
        : {}),
    }),
  );

  return {
    status: "processed",
    messages: parsed.messages.length,
    inserted,
    statuses: parsed.statuses.length,
    advanced,
    charges,
    skipped,
    media,
    flowAdvances,
    verseReplies,
    numberQualityUpdates: parsed.qualityUpdates.length,
    templatesUpdated,
    templatesUnmatched,
  };
}

/** Meta's error shape on a failed status, reduced to the two columns we keep. */
function readError(status: StatusUpdate): { code: number | null; title: string | null } {
  const first = status.errors[0] as
    | { code?: unknown; title?: unknown; message?: unknown }
    | undefined;

  return {
    code: typeof first?.code === "number" ? first.code : null,
    title:
      typeof first?.title === "string"
        ? first.title
        : typeof first?.message === "string"
          ? first.message
          : null,
  };
}

async function resolveNumber(
  companyId: string,
  cache: Map<string, string | null>,
  phoneNumberId: string,
): Promise<string | null> {
  /* One delivery is usually one number; the cache keeps a batch of twenty
     messages from being twenty identical lookups. */
  const cached = cache.get(phoneNumberId);
  if (cached !== undefined) return cached;

  const row = await withCompany(companyId, (db) =>
    db.whatsAppNumber.findFirst({
      where: { phoneNumberId },
      select: { id: true },
    }),
  );

  cache.set(phoneNumberId, row?.id ?? null);
  return row?.id ?? null;
}

interface MessageOutcome {
  inserted: boolean;
  media: MediaFetchRequest | null;
  /** Set when this message could move a flow. See FlowAdvanceRequest. */
  flow: FlowAdvanceRequest | null;
  /** Set when Verse should answer it. See VerseReplyRequest. */
  verse: VerseReplyRequest | null;
}

async function ingestMessage(
  db: CompanyClient,
  companyId: string,
  message: InboundMessage,
  whatsappNumberId: string,
): Promise<MessageOutcome> {
  /*
   * companyId is named in the update arm of both upserts below, and that is not
   * belt-and-braces - it is R3. The withCompany extension merges companyId into
   * `where` and into `create`, and NOT into `update`. An update arm here scopes
   * a row it found by a compound unique, so the value has to be written out.
   */
  const contact = await db.contact.upsert({
    where: { companyId_waId: { companyId, waId: message.from } },
    create: {
      companyId,
      waId: message.from,
      ...(message.profileName ? { profileName: message.profileName } : {}),
    },
    /*
     * The profile name is only ever written when Meta actually sent one. It
     * arrives on the first inbound message of a window and not reliably
     * afterwards, so assigning it unconditionally would blank a stored name on
     * the second message of every conversation - and the inbox would show a
     * phone number where it used to show a person.
     */
    update: {
      companyId,
      ...(message.profileName ? { profileName: message.profileName } : {}),
    },
    select: { id: true },
  });

  const conversation = await db.conversation.upsert({
    where: {
      companyId_contactId_whatsappNumberId: {
        companyId,
        contactId: contact.id,
        whatsappNumberId,
      },
    },
    create: {
      companyId,
      contactId: contact.id,
      whatsappNumberId,
      source: "INBOUND",
    },
    /*
     * Nothing to change. The timestamps, the window and the unread count are
     * advanced by advanceConversation below, in one statement that cannot move
     * them backwards - doing any of it here would be a second writer with
     * weaker rules.
     */
    update: { companyId },
    select: { id: true },
  });

  const body = message.text ?? message.caption;

  /*
   * createMany with skipDuplicates rather than create, because this exact
   * insert runs again whenever a delivery is reprocessed. The unique on
   * (company_id, wamid) turns the repeat into a no-op, and `count` is how we
   * learn which it was - which decides whether the conversation advances.
   *
   * Getting that wrong is not a crash. It is an unread count that climbs by one
   * every time Meta redelivers, on a badge somebody is trying to clear.
   */
  const created = await db.message.createMany({
    data: [
      {
        companyId,
        conversationId: conversation.id,
        direction: "INBOUND",
        /*
         * DELIVERED, not PENDING. The ladder describes an outbound message's
         * journey to the customer; an inbound one has already arrived by
         * definition, and PENDING would mean "accepted by us and not yet handed
         * over", which is a statement about sending.
         */
        status: "DELIVERED",
        type: message.type,
        wamid: message.wamid,
        body,
        occurredAt: message.occurredAt,
      },
    ],
    skipDuplicates: true,
  });

  const inserted = created.count === 1;

  if (inserted) {
    await advanceConversation(db, companyId, conversation.id, {
      occurredAt: message.occurredAt,
      preview: body,
      inbound: true,
      windowExpiresAt: windowExpiryFor(message.occurredAt),
      unread: 1,
    });
  }

  /*
   * Whether this message could move a flow.
   *
   * Only on an insert, because a redelivery must not advance a run twice - the
   * second advance would send the next question again and move the position
   * past an answer the customer gave once. Meta redelivers freely, so this is
   * an ordinary Tuesday rather than an edge case.
   *
   * A tap of any kind always qualifies: it may be an entry that starts a run
   * where none exists. A typed reply qualifies only when this conversation has
   * a run waiting on it, which is one indexed lookup - the alternative, handing
   * every inbound text to the engine, would be a job per customer message
   * across every tenant for the sake of the few answering a collect node.
   */
  const flow = inserted
    ? await flowAdvanceFor(db, companyId, message, conversation.id)
    : null;

  /*
   * Whether Verse should answer this message.
   *
   * Only on an insert, for the reason the flow gate gives: a redelivery must
   * not produce a second answer. Meta redelivers freely.
   *
   * And only when a flow is NOT also advancing. Both driving one thread is the
   * two-writer bug the driver column exists to prevent - and while the column
   * makes it unrepresentable, enqueueing both would still spend a model call
   * to discover that. The driver check below is what actually decides; this
   * ordering just avoids paying for the answer.
   */
  const verse =
    inserted && !flow
      ? await verseReplyFor(db, message, conversation.id)
      : null;

  if (!message.mediaId) return { inserted, media: null, flow, verse };

  /*
   * The row is read back rather than returned by the insert, because
   * createMany does not return rows and because on a redelivery there was no
   * insert at all. Only the id and whether bytes are already attached matter.
   */
  const row = await db.message.findFirst({
    where: { wamid: message.wamid },
    select: { id: true, mediaId: true },
  });

  if (!row || row.mediaId) return { inserted, media: null, flow, verse };

  return {
    inserted,
    media: { messageId: row.id, metaMediaId: message.mediaId },
    flow,
    verse,
  };
}

/**
 * The advance request for one inserted inbound message, or null.
 *
 * Reads the message row back for its id, which is what the flow's step log
 * points at. createMany does not return rows, and the id is needed on the
 * DECLINED step as much as on the successful one - a refused tap that named no
 * message would be a log entry nobody could tie to a thread.
 */
/**
 * Whether this inbound message is one Verse should answer.
 *
 * One indexed lookup on the conversation's driver. A typed reply in a thread
 * Verse is driving qualifies; everything else does not - a thread held by an
 * operator, by a flow, or by nobody.
 *
 * A tap is deliberately NOT collected. Verse answers words, and a customer
 * tapping a button left over from a flow that has since handed over is not
 * asking Verse anything.
 */
async function verseReplyFor(
  db: CompanyClient,
  message: InboundMessage,
  conversationId: string,
): Promise<VerseReplyRequest | null> {
  if (message.text === null) return null;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId },
    select: { driver: true },
  });

  if (conversation?.driver !== "VERSE") return null;

  const row = await db.message.findFirst({
    where: { conversationId, wamid: message.wamid },
    select: { id: true },
  });

  return row ? { conversationId, messageId: row.id } : null;
}

async function flowAdvanceFor(
  db: CompanyClient,
  companyId: string,
  message: InboundMessage,
  conversationId: string,
): Promise<FlowAdvanceRequest | null> {
  if (message.replyId === null) {
    if (message.text === null) return null;

    const waiting = await db.flowRun.findFirst({
      where: { activeConversationId: conversationId },
      select: { id: true },
    });

    if (!waiting) return null;
  }

  const row = await db.message.findFirst({
    where: { wamid: message.wamid },
    select: { id: true },
  });

  if (!row) return null;

  return {
    conversationId,
    messageId: row.id,
    replyId: message.replyId,
    text: message.text,
    occurredAt: message.occurredAt,
  };
}

/**
 * Media referenced by a delivery whose bytes are still missing.
 *
 * Used on the already-processed path, where nothing is inserted but a lost
 * enqueue would otherwise leave a message pointing at nothing for ever.
 */
async function outstandingMedia(
  companyId: string,
  messages: readonly InboundMessage[],
): Promise<MediaFetchRequest[]> {
  const wanted = messages.filter((message) => message.mediaId !== null);
  if (wanted.length === 0) return [];

  const rows = await withCompany(companyId, (db) =>
    db.message.findMany({
      where: { wamid: { in: wanted.map((message) => message.wamid) }, mediaId: null },
      select: { id: true, wamid: true },
    }),
  );

  const byWamid = new Map(rows.map((row) => [row.wamid, row.id]));

  return wanted
    .map((message) => ({
      messageId: byWamid.get(message.wamid),
      metaMediaId: message.mediaId!,
    }))
    .filter((request): request is MediaFetchRequest => request.messageId !== undefined);
}
