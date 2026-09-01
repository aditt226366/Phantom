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
  WHATSAPP_TEMPLATE_SUBMIT: "whatsapp.template.submit",
  WHATSAPP_TEMPLATE_SYNC: "whatsapp.template.sync",
  BROADCAST_START: "broadcast.start",
  LEAD_SOURCE_POLL: "lead-source.poll",
  DASHBOARD_ROLLUP: "dashboard.rollup",
  VERSE_INGEST: "verse.ingest",
  VERSE_REPLY: "verse.reply",
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

/** Read every template Meta holds for this WABA and adopt the unknown ones. */
export const whatsappTemplateSyncJobSchema = z.object({
  companyId: z.string().min(1),
});

export type WhatsAppTemplateSyncJob = z.infer<typeof whatsappTemplateSyncJobSchema>;

/** Hand one already-persisted template to Meta. */
export const whatsappTemplateSubmitJobSchema = z.object({
  companyId: z.string().min(1),
  templateId: z.string().min(1),
});

export type WhatsAppTemplateSubmitJob = z.infer<
  typeof whatsappTemplateSubmitJobSchema
>;

/**
 * The job id for a submission, naming the attempt.
 *
 * The same reasoning as sendJobId (R2): BullMQ keeps completed ids for an hour
 * and refuses a job whose id it already holds, silently. A resubmit after a
 * rejection re-enqueued under the first attempt's id would be dropped and the
 * Fix-and-resubmit button would look dead.
 *
 * Unlike a send, a repeat here is safe - Meta refuses a duplicate name rather
 * than creating a second template - so this is about the button working, not
 * about a message reaching a customer twice.
 */
export function templateSubmitJobId(templateId: string, attempt: number): string {
  return `template:${templateId}:${attempt}`;
}

export const whatsappNumbersRefreshJobSchema = z.object({
  companyId: z.string().min(1),
});

/**
 * Turn one broadcast's audience into messages, and schedule every send.
 *
 * The payload carries an id and nothing else - not the audience. Ten thousand
 * recipients would be a megabyte of Redis per broadcast and a second copy of
 * the truth; the rows are already in the database, which is where this job
 * reads them from in batches.
 *
 * Re-runnable by construction. It claims recipients that are still PENDING, so
 * a job that dies half way through and is retried picks up where it stopped
 * rather than sending the first half twice.
 */
export const broadcastStartJobSchema = z.object({
  companyId: z.string().min(1),
  broadcastId: z.string().min(1),
  /**
   * Where to resume from, as a count of recipients already scheduled.
   *
   * Present on a resume, so the delays continue the run rather than restarting
   * the whole schedule at zero and sending the remainder in one burst.
   */
  scheduledSoFar: z.number().int().min(0).default(0),
});

export type BroadcastStartJob = z.infer<typeof broadcastStartJobSchema>;

/**
 * The job id for a broadcast run.
 *
 * Named with the attempt, for the reason sendJobId is: BullMQ keeps completed
 * ids for an hour and refuses a job whose id it already holds, silently. A
 * pause followed by a resume inside that hour would otherwise be dropped, and
 * the Resume button would look dead.
 */
export function broadcastStartJobId(broadcastId: string, run: number): string {
  return `broadcast:${broadcastId}:${run}`;
}

export type WhatsAppNumbersRefreshJob = z.infer<
  typeof whatsappNumbersRefreshJobSchema
>;

/**
 * Read one bound spreadsheet and act on the rows that are new.
 *
 * ---------------------------------------------------------------------------
 * One repeatable job per binding, and no sweeping poller
 * ---------------------------------------------------------------------------
 *
 * The obvious design is a single job that wakes every thirty seconds and polls
 * every active binding. It is not available here, and the reason is the same
 * one that shapes integration.verify and vault.reseal: this process connects as
 * app_runtime with NO company context, so `SELECT * FROM lead_sources` returns
 * zero rows, succeeds, and looks exactly like "nothing to do". A sweeper would
 * run for ever and poll nothing, silently.
 *
 * So the fan-out lives where a company id can be established, which is the web
 * side after requireSession(). Creating a binding registers a BullMQ job
 * scheduler carrying its companyId; deleting one removes the scheduler. The
 * queue holds the schedule, so a worker restart resumes every binding for free.
 *
 * The companyId in this payload is the third of the three trusted origins in
 * CLAUDE.md rule 3 - it is here because a server action put it here after
 * resolving a session, and everything downstream depends on nothing but our own
 * code being able to write to Redis.
 */
export const leadSourcePollJobSchema = z.object({
  companyId: z.string().min(1),
  leadSourceId: z.string().min(1),
});

export type LeadSourcePollJob = z.infer<typeof leadSourcePollJobSchema>;

/**
 * The scheduler id for one binding's poll.
 *
 * Deterministic and derived from the binding id, because upsertJobScheduler is
 * an upsert on this key: changing a binding's interval re-registers under the
 * same id and replaces the schedule rather than adding a second one. A random
 * or timestamped id would leave the old schedule running, and the binding would
 * quietly poll twice as often - which is a quota problem for every other tenant
 * before it is a visible problem for this one.
 *
 * It is also what removal needs. A binding deleted without its scheduler
 * removed is a job that wakes for ever, finds nothing, and logs a not-found on
 * every tick.
 */
export function leadSourceSchedulerId(leadSourceId: string): string {
  return `lead-source:${leadSourceId}`;
}

/**
 * Recompute one company's dashboard rollup.
 *
 * ---------------------------------------------------------------------------
 * One repeatable job per company, for the third time
 * ---------------------------------------------------------------------------
 *
 * The same constraint that shaped integration.verify, vault.reseal and
 * lead-source.poll, and it is worth restating because the obvious design here
 * is even more tempting than it was there: a single job that wakes every sixty
 * seconds and refreshes every company.
 *
 * It is not available. This process connects as app_runtime with NO company
 * context, so `SELECT id FROM companies` returns zero rows, succeeds, and looks
 * exactly like "no companies to refresh". A sweeper would run for ever, refresh
 * nothing, log nothing, and the dashboard would sit at whatever it said on the
 * day the feature shipped.
 *
 * So the fan-out lives where a company id can be established. A scheduler is
 * registered when the company is created - the signup action, after the
 * transaction commits - and scripts/schedule-dashboard-rollups.mjs registers
 * one for every company that predates this phase, through the admin client,
 * which is the only client in the system that can enumerate them.
 *
 * ---------------------------------------------------------------------------
 * Why the payload carries no bounds
 * ---------------------------------------------------------------------------
 *
 * A repeatable job's data is fixed at registration. Putting the day boundary in
 * it would freeze the definition of "today" at the moment the company signed
 * up, and every count under that heading would be about that day for ever.
 *
 * The handler computes its bounds when it runs, which is the only moment they
 * can be right. The instants are still bound parameters by the time they reach
 * the database - see @whatsapp-os/core/dashboard - so nothing about that
 * weakens the planner argument.
 */
export const dashboardRollupJobSchema = z.object({
  companyId: z.string().min(1),
});

export type DashboardRollupJob = z.infer<typeof dashboardRollupJobSchema>;

/**
 * The scheduler id for one company's refresh.
 *
 * Deterministic and derived from the company id, for the reason
 * leadSourceSchedulerId is: upsertJobScheduler is an upsert on this key.
 * Registering twice - a re-run of the backfill script beside a signup that
 * already registered one - replaces the schedule rather than adding a second,
 * so a company cannot end up refreshing twice a minute and paying for both.
 */
export function dashboardRollupSchedulerId(companyId: string): string {
  return `dashboard-rollup:${companyId}`;
}

/**
 * Ingest one knowledge base document: extract, chunk, embed, store.
 *
 * The payload carries the document id and nothing else - not the bytes. A PDF
 * is already stored, and putting it in the job would duplicate every upload
 * into Redis, including the ones at the size cap. The same reasoning as
 * whatsapp.webhook carrying an event id.
 *
 * Re-runnable by construction: replaceChunks deletes the document's passages
 * before inserting, so a job that dies half way and is retried does not leave
 * a document holding two overlapping sets of chunks.
 */
export const verseIngestJobSchema = z.object({
  companyId: z.string().min(1),
  documentId: z.string().min(1),
});

export type VerseIngestJob = z.infer<typeof verseIngestJobSchema>;

/**
 * Answer one inbound customer message with Verse.
 *
 * Carries the message id rather than its text, so the handler reads the
 * conversation as it stands at the moment it runs rather than as it stood when
 * the webhook landed. Those differ whenever a customer sends two messages in a
 * row, and answering the first in ignorance of the second is how an assistant
 * replies to a question that has already been withdrawn.
 */
export const verseReplyJobSchema = z.object({
  companyId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

export type VerseReplyJob = z.infer<typeof verseReplyJobSchema>;

/**
 * The job id for a Verse reply, naming the message.
 *
 * BullMQ refuses a job whose id it already holds, so this is the deduplication:
 * two webhook deliveries of the same customer message must not produce two
 * answers, and Meta redelivers. The message id rather than the conversation id,
 * because a genuinely new message in the same thread IS a new job.
 */
export function verseReplyJobId(messageId: string): string {
  return `verse-reply:${messageId}`;
}

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
  [JOB_NAMES.WHATSAPP_TEMPLATE_SUBMIT]: whatsappTemplateSubmitJobSchema,
  [JOB_NAMES.WHATSAPP_TEMPLATE_SYNC]: whatsappTemplateSyncJobSchema,
  [JOB_NAMES.BROADCAST_START]: broadcastStartJobSchema,
  [JOB_NAMES.LEAD_SOURCE_POLL]: leadSourcePollJobSchema,
  [JOB_NAMES.DASHBOARD_ROLLUP]: dashboardRollupJobSchema,
  [JOB_NAMES.VERSE_INGEST]: verseIngestJobSchema,
  [JOB_NAMES.VERSE_REPLY]: verseReplyJobSchema,
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
