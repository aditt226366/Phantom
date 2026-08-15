import type { CompanyClient } from "./with-company.ts";

/**
 * Recording a webhook delivery, and deciding whether it needs processing.
 *
 * This lives here rather than in the route handler because the interesting
 * decision is one line long and getting it wrong loses customer messages
 * silently. See recordWebhookDelivery.
 */

/** 64 KiB. Generous for Meta; a large batch of statuses is a few KB. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 64 * 1024;

export interface WebhookDeliveryInput {
  integrationId: string;
  /** sha256 of the raw body, hex. */
  deliveryKey: string;
  /** The raw body, exactly as received. Truncated here if oversized. */
  payload: string;
}

export interface WebhookDelivery {
  eventId: string;
  /**
   * Whether the caller should enqueue processing.
   *
   * True for a first delivery, and true again for a redelivery of something
   * never processed - see the note in recordWebhookDelivery.
   */
  enqueue: boolean;
  /** Meta has sent this exact body before. */
  redelivery: boolean;
  /**
   * How many times this body has now arrived. Belongs in the job id: BullMQ
   * keeps failed job ids for a day, so a recovery re-enqueued under the id the
   * first attempt used would be silently dropped.
   */
  deliveryCount: number;
}

/**
 * Truncate to the cap, on bytes rather than characters.
 *
 * A JSON body is mostly ASCII but Meta forwards message text, which is not -
 * slicing by string length would let a payload of emoji exceed the byte cap and
 * be refused by the CHECK constraint.
 */
function capPayload(payload: string): { payload: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(payload);
  if (encoded.byteLength <= MAX_WEBHOOK_PAYLOAD_BYTES) {
    return { payload, truncated: false };
  }

  /* fatal: false so a cut through a multi-byte sequence yields U+FFFD rather
     than throwing - a slightly mangled last character beats losing the record. */
  let cut = new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.subarray(0, MAX_WEBHOOK_PAYLOAD_BYTES),
  );

  /*
   * Decoding can make it LONGER, which is not obvious and cost a test failure.
   *
   * Two orphaned bytes of a four-byte emoji decode to one U+FFFD, and U+FFFD
   * re-encodes to three bytes - so a cut landing mid-sequence can come back one
   * byte over the cap and be refused by the CHECK constraint. Trim until it
   * actually fits; at most a character or two.
   */
  const encoder = new TextEncoder();
  while (encoder.encode(cut).byteLength > MAX_WEBHOOK_PAYLOAD_BYTES) {
    cut = cut.slice(0, -1);
  }

  return { payload: cut, truncated: true };
}

/**
 * Record one delivery, and say whether it needs a job.
 *
 * The whole design is in the conflict path, so it is worth stating plainly.
 *
 * ON CONFLICT DO NOTHING would be wrong. "Already recorded" is not "already
 * processed": if the first delivery inserted the row and enqueued a job, and
 * that job was then lost - worker killed mid-restart, Redis flushed, attempts
 * exhausted - Meta's retry is the only surviving copy of that customer's
 * message. Dropping it because a row exists loses the message permanently.
 *
 * So the conflict path reads processed_at. Null means the work never finished
 * and the delivery is enqueued again. Dedupe prevents double processing; it
 * must not prevent recovery.
 *
 * One statement, because the route runs inside Meta's five-second budget and
 * because a read-then-write would race a concurrent redelivery.
 */
export async function recordWebhookDelivery(
  db: CompanyClient,
  companyId: string,
  input: WebhookDeliveryInput,
): Promise<WebhookDelivery> {
  const { payload, truncated } = capPayload(input.payload);

  const row = await db.whatsAppWebhookEvent.upsert({
    where: {
      companyId_deliveryKey: { companyId, deliveryKey: input.deliveryKey },
    },
    create: {
      companyId,
      integrationId: input.integrationId,
      deliveryKey: input.deliveryKey,
      payload,
      payloadTruncated: truncated,
    },
    /*
     * Incremented on every redelivery, including ones that need no work - the
     * count means "times Meta sent this", not "times we enqueued it", which is
     * the more useful thing to have when reading the row later.
     *
     * companyId is not named here and does not need to be: the extension merges
     * it into `where`, and the RLS USING clause restricts which row an UPDATE
     * can reach. Worth saying because the extension does NOT merge it into
     * `update`, so an arm that scoped anything would have to say so itself.
     */
    update: { deliveryCount: { increment: 1 } },
    select: { id: true, processedAt: true, deliveryCount: true },
  });

  return {
    eventId: row.id,
    enqueue: row.processedAt === null,
    redelivery: row.deliveryCount > 1,
    deliveryCount: row.deliveryCount,
  };
}

export interface WebhookOutcome {
  /** Why nothing was done. 'company_deactivated' is not an error. */
  skippedReason?: string;
  /** Already scrubbed. Never contains a credential. */
  error?: string;
}

/**
 * Mark a delivery finished.
 *
 * Called whatever the outcome, including a deliberate skip: an event left
 * unprocessed is indistinguishable from one whose job vanished, and the
 * unprocessed backlog is a health signal that only works if it is honest.
 */
export async function markWebhookProcessed(
  db: CompanyClient,
  companyId: string,
  eventId: string,
  outcome: WebhookOutcome = {},
): Promise<void> {
  await db.whatsAppWebhookEvent.update({
    where: { id: eventId },
    data: {
      processedAt: new Date(),
      skippedReason: outcome.skippedReason ?? null,
      error: outcome.error ?? null,
    },
  });
}

/**
 * Deliveries that arrived and were never finished.
 *
 * `before` is passed in rather than computed as now() in SQL, deliberately:
 * a range against now() estimates at one row however much data is present and
 * the planner abandons the index. 20260815130000 measured that at 63x on a
 * comparable query.
 */
export async function countUnprocessedWebhooks(
  db: CompanyClient,
  companyId: string,
  before: Date,
): Promise<number> {
  return db.whatsAppWebhookEvent.count({
    where: { processedAt: null, createdAt: { lt: before } },
  });
}
