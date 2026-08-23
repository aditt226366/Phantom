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
  /** Machine codes, never prose. Aggregated for the operator counts. */
  skipped: IngestSkipReason[];
  /** For the caller to enqueue, once it is no longer holding a scope. */
  media: MediaFetchRequest[];
  /**
   * Meta said a number's quality or tier moved, so the cache is stale.
   *
   * A count rather than the payload's contents, deliberately: the refresh reads
   * the whole account from Meta and writes what comes back, so the notification
   * is a reason to look, not a thing to store. Enqueued by the caller, like the
   * media requests, once no scope is open.
   */
  numberQualityUpdates: number;
}

function emptySummary(status: IngestSummary["status"]): IngestSummary {
  return {
    status,
    messages: 0,
    inserted: 0,
    statuses: 0,
    advanced: 0,
    skipped: [],
    media: [],
    numberQualityUpdates: 0,
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
  }

  let advanced = 0;

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
    skipped,
    media,
    numberQualityUpdates: parsed.qualityUpdates.length,
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

  if (!message.mediaId) return { inserted, media: null };

  /*
   * The row is read back rather than returned by the insert, because
   * createMany does not return rows and because on a redelivery there was no
   * insert at all. Only the id and whether bytes are already attached matter.
   */
  const row = await db.message.findFirst({
    where: { wamid: message.wamid },
    select: { id: true, mediaId: true },
  });

  if (!row || row.mediaId) return { inserted, media: null };

  return { inserted, media: { messageId: row.id, metaMediaId: message.mediaId } };
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
