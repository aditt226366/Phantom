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
import { handleIntegrationVerify } from "./jobs/integration-verify.ts";
import { handleVaultReseal } from "./jobs/vault-reseal.ts";
import { handleWhatsAppWebhook } from "./jobs/whatsapp-webhook.ts";
import { handleWhatsAppMediaFetch } from "./jobs/whatsapp-media.ts";
import { handleWhatsAppMarkRead } from "./jobs/whatsapp-mark-read.ts";
import { handleWhatsAppNumbersRefresh } from "./jobs/whatsapp-numbers.ts";
import { handleWhatsAppMessageSend } from "./jobs/whatsapp-send.ts";
import { systemQueue } from "./queue.ts";

/**
 * whatsapp-os background worker.
 *
 * Runs BullMQ consumers against Redis: the system ping, integration
 * verification, and vault key rotation. Both product jobs take a companyId,
 * because this process cannot enumerate companies - it connects as app_runtime
 * with no company context, so a cross-company SELECT returns zero rows,
 * succeeds, and looks exactly like "nothing to do". The fan-out happens on the
 * web side, which holds the admin client.
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

    case JOB_NAMES.INTEGRATION_VERIFY:
      /*
       * The job id is passed through as the usage idempotency key. Every one
       * of the five attempts carries the same id, so one provider call is
       * charged once however many attempts it took to record.
       */
      return handleIntegrationVerify(
        parseJobPayload(JOB_NAMES.INTEGRATION_VERIFY, job.data),
        job.id ?? `${job.name}:${job.timestamp}`,
      );

    case JOB_NAMES.VAULT_RESEAL:
      return handleVaultReseal(
        parseJobPayload(JOB_NAMES.VAULT_RESEAL, job.data),
      );

    case JOB_NAMES.WHATSAPP_WEBHOOK:
      return handleWhatsAppWebhook(
        parseJobPayload(JOB_NAMES.WHATSAPP_WEBHOOK, job.data),
      );

    case JOB_NAMES.WHATSAPP_MESSAGE_SEND:
      /*
       * No job id is threaded through: usage is deduped on the message id, not
       * the job (C3), and this job runs once by contract anyway.
       */
      return handleWhatsAppMessageSend(
        parseJobPayload(JOB_NAMES.WHATSAPP_MESSAGE_SEND, job.data),
      );

    case JOB_NAMES.WHATSAPP_MEDIA_FETCH:
      return handleWhatsAppMediaFetch(
        parseJobPayload(JOB_NAMES.WHATSAPP_MEDIA_FETCH, job.data),
      );

    case JOB_NAMES.WHATSAPP_MARK_READ:
      return handleWhatsAppMarkRead(
        parseJobPayload(JOB_NAMES.WHATSAPP_MARK_READ, job.data),
      );

    case JOB_NAMES.WHATSAPP_NUMBERS_REFRESH:
      /* The job id is the usage dedupe key, as with integration.verify. */
      return handleWhatsAppNumbersRefresh(
        parseJobPayload(JOB_NAMES.WHATSAPP_NUMBERS_REFRESH, job.data),
        job.id ?? `${job.name}:${job.timestamp}`,
      );

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
    /* The producer holds its own connection, so it needs its own close - a
       missed one keeps the process alive after the worker has stopped. */
    await systemQueue.close();
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
