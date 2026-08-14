/* Must come first: importing env.ts loads the repo-root .env as a side effect,
   before any module that reads process.env is evaluated. The Prisma client is
   lazy so it no longer depends on this, but keeping the order explicit means a
   future eager reader does not reintroduce the bug. */
import { env } from "./env.ts";

import { Worker, type Job } from "bullmq";
import { prisma } from "@whatsapp-os/db";
import { JOB_NAMES, QUEUE_NAMES, parseJobPayload } from "@whatsapp-os/core";
import { connection } from "./redis.ts";
import { log } from "./logger.ts";
import { handlePing } from "./jobs/ping.ts";

/**
 * whatsapp-os background worker.
 *
 * Runs BullMQ consumers against Redis. No product jobs yet - only the system
 * ping, which proves the enqueue -> consume -> database path is wired.
 */

async function processJob(job: Job): Promise<unknown> {
  /**
   * Re-validate on the way in. The payload may have been enqueued by an older
   * deploy with a different shape, and a queue is a trust boundary like any
   * other. parseJobPayload throws, which BullMQ records as a failed attempt.
   */
  switch (job.name) {
    case JOB_NAMES.PING:
      return handlePing(parseJobPayload(JOB_NAMES.PING, job.data));

    default:
      throw new Error(`No handler registered for job "${job.name}"`);
  }
}

const worker = new Worker(QUEUE_NAMES.SYSTEM, processJob, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
  prefix: env.QUEUE_PREFIX,
});

worker.on("completed", (job) => {
  log.info("job completed", { id: job.id, name: job.name });
});

worker.on("failed", (job, error) => {
  log.error("job failed", {
    id: job?.id,
    name: job?.name,
    attempt: job?.attemptsMade,
    error: error.message,
  });
});

worker.on("error", (error) => {
  log.error("worker error", { error: error.message });
});

log.info("worker started", {
  queue: QUEUE_NAMES.SYSTEM,
  prefix: env.QUEUE_PREFIX,
  concurrency: env.WORKER_CONCURRENCY,
});

/**
 * Graceful shutdown.
 *
 * `worker.close()` stops accepting new jobs and waits for in-flight ones to
 * finish, so a deploy does not tear a half-done job in two. Without this, a
 * container stop kills the process mid-job and the work is only recovered when
 * the stalled-job check eventually fires.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("shutting down", { signal });

  try {
    await worker.close();
    await connection.quit();
    await prisma.$disconnect();
    log.info("shutdown complete");
    process.exit(0);
  } catch (error) {
    log.error("shutdown failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
});
