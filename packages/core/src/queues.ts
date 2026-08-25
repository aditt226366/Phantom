import { z } from "zod";

/**
 * Queue contracts shared by the producer (apps/web) and the consumer
 * (apps/worker).
 *
 * The point of putting these here rather than in either app: a job payload is
 * an interface between two separately deployed processes. If the web app can
 * enqueue a shape the worker cannot parse, that is a runtime failure in
 * production with a poisoned queue behind it. Declaring the payload once, as a
 * Zod schema both sides import, turns that into a compile-time error.
 *
 * Rule: the worker re-validates every payload it receives. Never trust a job
 * body just because it came off your own queue - it may have been enqueued by
 * an older deploy.
 */

export const QUEUE_NAMES = {
  /** Infrastructure heartbeat. Proves the enqueue -> process loop works. */
  SYSTEM: "system",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/* -------------------------------------------------------------------------
   System queue
   ------------------------------------------------------------------------- */

export const JOB_NAMES = {
  PING: "system.ping",
  INTEGRATION_VERIFY: "integration.verify",
  VAULT_RESEAL: "vault.reseal",
  WHATSAPP_WEBHOOK: "whatsapp.webhook",
  WHATSAPP_MESSAGE_SEND: "whatsapp.message.send",
  WHATSAPP_MARK_READ: "whatsapp.mark.read",
  WHATSAPP_MEDIA_FETCH: "whatsapp.media.fetch",
  WHATSAPP_NUMBERS_REFRESH: "whatsapp.numbers.refresh",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** A no-op job used to verify the queue round-trip end to end. */
export const pingJobSchema = z.object({
  /** Echoed back in the job result, so a caller can correlate. */
  nonce: z.string().min(1).max(128),
  /** ISO-8601 timestamp recorded at enqueue time. */
  enqueuedAt: z.iso.datetime(),
});

export type PingJob = z.infer<typeof pingJobSchema>;

/**
 * Verify one company's integrations against the real providers.
 *
 * One company per job, because the worker cannot enumerate them: it connects
 * as app_runtime with no company context, so a cross-company SELECT returns
 * zero rows, succeeds, and looks exactly like "nothing to do". The fan-out
 * happens on the web side, which has the admin client.
 */
export const integrationVerifyJobSchema = z.object({
  companyId: z.string().min(1),
  /** Omitted to verify every integration the company has. */
  integrationId: z.string().min(1).optional(),
});

export type IntegrationVerifyJob = z.infer<typeof integrationVerifyJobSchema>;

/**
 * Re-encrypt one company's secrets under the active key.
 *
 * Filters on key_id, so re-running is a no-op and a crash resumes naturally.
 */
export const vaultResealJobSchema = z.object({
  companyId: z.string().min(1),
});

export type VaultResealJob = z.infer<typeof vaultResealJobSchema>;

/**
 * Process one recorded webhook delivery.
 *
 * Carries the event id rather than the payload: the body is already stored
 * verbatim, and putting it in the job too would duplicate every inbound
 * message into Redis - including the ones over the size cap.
 */
export const whatsappWebhookJobSchema = z.object({
  companyId: z.string().min(1),
  eventId: z.string().min(1),
});

export type WhatsAppWebhookJob = z.infer<typeof whatsappWebhookJobSchema>;

/** Hand one already-persisted message to Meta. */
export const whatsappMessageSendJobSchema = z.object({
  companyId: z.string().min(1),
  messageId: z.string().min(1),
  /**
   * Which attempt this is, mirroring messages.send_attempt.
   *
   * Part of the job id, because BullMQ keeps completed and failed ids for
   * hours - a retry re-enqueued under the first attempt's id is silently
   * dropped and the button appears to do nothing.
   */
  sendAttempt: z.number().int().min(0),
});

export type WhatsAppMessageSendJob = z.infer<typeof whatsappMessageSendJobSchema>;

/**
 * The job id for a send, naming the attempt as well as the message.
 *
 * R2, and the reason `sendAttempt` exists on the row at all. BullMQ keeps
 * completed job ids for an hour and failed ones for a day, and refuses a job
 * whose id it already holds - silently, because for every other job in this
 * system that refusal IS the deduplication. A retry re-enqueued under the first
 * attempt's id is therefore dropped without an error anywhere, and the button
 * the operator pressed appears to do nothing at all.
 *
 * So the attempt is in the id. Retrying message X for the second time is a
 * different job from sending it the first, which is the truth of it: the send
 * job runs with attempts: 1, so every subsequent try is a person deciding to
 * send again rather than a queue retrying on its own.
 */
export function sendJobId(messageId: string, sendAttempt: number): string {
  return `send:${messageId}:${sendAttempt}`;
}

export const whatsappMarkReadJobSchema = z.object({
  companyId: z.string().min(1),
  conversationId: z.string().min(1),
});

export type WhatsAppMarkReadJob = z.infer<typeof whatsappMarkReadJobSchema>;

/**
 * The job id for a read receipt, keyed on the thread AND the message.
 *
 * Opening a thread three times must not tell Meta three times. BullMQ refuses a
 * job whose id it already holds, so the id is the deduplication - and it has to
 * name the message, not just the conversation: keyed on the conversation alone,
 * a genuinely new message arriving after the first open would be silently
 * dropped as a duplicate and never marked read at all.
 *
 * The message id rather than the wamid, because the enqueue site has ours in
 * hand and does not need a second lookup for Meta's.
 *
 * Dedup here is a burst guard, not a permanent record: BullMQ keeps completed
 * ids for an hour. The rule that stops the steady-state noise is upstream -
 * readReceiptTarget returns null when nothing is unread, so re-opening a thread
 * that is already read enqueues nothing at all.
 */
export function markReadJobId(conversationId: string, messageId: string): string {
  return `read:${conversationId}:${messageId}`;
}

export const whatsappMediaFetchJobSchema = z.object({
  companyId: z.string().min(1),
  messageId: z.string().min(1),
  /** Meta's media id. Its download URL expires in minutes. */
  metaMediaId: z.string().min(1),
});

export type WhatsAppMediaFetchJob = z.infer<typeof whatsappMediaFetchJobSchema>;

export const whatsappNumbersRefreshJobSchema = z.object({
  companyId: z.string().min(1),
});

export type WhatsAppNumbersRefreshJob = z.infer<
  typeof whatsappNumbersRefreshJobSchema
>;

/**
 * The send job runs ONCE. Everything else keeps the default five attempts.
 *
 * Meta's /messages endpoint has no idempotency key and no "did this land"
 * lookup. A timeout after Meta processed the request is indistinguishable from
 * a timeout before it did, so an automatic retry sends a real customer the
 * same message a second time - the worst failure this phase can produce, and
 * one that cannot be un-sent.
 *
 * Read that as an oversight and "fixing" it back to five is a data-integrity
 * regression, which is why it is written here rather than left to the call
 * site.
 *
 * The narrower danger is worth stating, because it shapes the UI: only the
 * AMBIGUOUS outcome is unsafe. A structured error from Meta proves the message
 * was not sent, and those are surfaced in the failed bubble as explicitly
 * retryable with Meta's own reason - see SendRefused in whatsapp/graph.ts. It
 * is the timeouts that get no automatic second chance and a person deciding.
 */
export const SEND_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
} as const;

/**
 * Registry mapping each job name to the schema that validates its payload.
 * The worker looks the schema up by job name, so adding a job means adding one
 * entry here and one handler - the wiring is not duplicated.
 */
export const JOB_SCHEMAS = {
  [JOB_NAMES.PING]: pingJobSchema,
  [JOB_NAMES.INTEGRATION_VERIFY]: integrationVerifyJobSchema,
  [JOB_NAMES.VAULT_RESEAL]: vaultResealJobSchema,
  [JOB_NAMES.WHATSAPP_WEBHOOK]: whatsappWebhookJobSchema,
  [JOB_NAMES.WHATSAPP_MESSAGE_SEND]: whatsappMessageSendJobSchema,
  [JOB_NAMES.WHATSAPP_MARK_READ]: whatsappMarkReadJobSchema,
  [JOB_NAMES.WHATSAPP_MEDIA_FETCH]: whatsappMediaFetchJobSchema,
  [JOB_NAMES.WHATSAPP_NUMBERS_REFRESH]: whatsappNumbersRefreshJobSchema,
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayloadFor<N extends JobName> = z.infer<(typeof JOB_SCHEMAS)[N]>;

/**
 * Parse an unknown job payload against its registered schema.
 * Throws with the job name in the message so a failed job is traceable.
 */
export function parseJobPayload<N extends JobName>(
  name: N,
  payload: unknown,
): JobPayloadFor<N> {
  const schema = JOB_SCHEMAS[name];

  if (!schema) {
    throw new Error(`No payload schema registered for job "${name}"`);
  }

  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new Error(
      `Invalid payload for job "${name}": ${JSON.stringify(result.error.issues)}`,
    );
  }

  return result.data as JobPayloadFor<N>;
}

/**
 * Default retry/backoff policy.
 *
 * Exponential from 1s, five attempts. Completed jobs are trimmed aggressively
 * and failures kept longer, because a failed job is the one you actually need
 * to read later.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
} as const;
