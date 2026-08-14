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
 * Registry mapping each job name to the schema that validates its payload.
 * The worker looks the schema up by job name, so adding a job means adding one
 * entry here and one handler - the wiring is not duplicated.
 */
export const JOB_SCHEMAS = {
  [JOB_NAMES.PING]: pingJobSchema,
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
