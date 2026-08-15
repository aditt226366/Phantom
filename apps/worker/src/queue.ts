import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "@whatsapp-os/core";
import { env } from "./env.ts";

/**
 * The worker's producer side.
 *
 * Until now this process only consumed. Webhook ingestion is the first job that
 * produces another - an inbound media message records a reference and hands the
 * download to a second job, because fetching the bytes is a Graph call and the
 * ingest path must not make one.
 *
 * A separate Queue rather than reusing the consumer's connection: BullMQ needs
 * `maxRetriesPerRequest: null` for the blocking commands a Worker issues, and
 * that setting is wrong for ordinary enqueues, where a request that cannot
 * reach Redis should fail rather than hang.
 */
export const systemQueue = new Queue(QUEUE_NAMES.SYSTEM, {
  connection: { url: env.REDIS_URL },
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
