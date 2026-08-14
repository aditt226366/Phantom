import "server-only";
import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "@whatsapp-os/core";

/**
 * The producer side of the queue.
 *
 * The web app enqueues; apps/worker consumes. Both import the payload schemas
 * from @whatsapp-os/core so the two processes cannot disagree about a job's
 * shape.
 *
 * BullMQ opens its own ioredis connection from this URL rather than sharing
 * lib/redis.ts, because the two need different retry semantics.
 */

const globalForQueue = globalThis as unknown as {
  __whatsappOsSystemQueue?: Queue;
};

function createSystemQueue(): Queue {
  return new Queue(QUEUE_NAMES.SYSTEM, {
    connection: {
      url: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
    },
    prefix: process.env["QUEUE_PREFIX"] ?? "whatsapp-os",
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export const systemQueue: Queue =
  globalForQueue.__whatsappOsSystemQueue ?? createSystemQueue();

if (process.env["NODE_ENV"] !== "production") {
  globalForQueue.__whatsappOsSystemQueue = systemQueue;
}
