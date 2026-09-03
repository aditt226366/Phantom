import {
  JOB_NAMES,
  sendJobId,
  verseReplyJobId,
  type WhatsAppWebhookJob,
} from "@whatsapp-os/core";
import {
  advanceFlow,
  ingestWebhookDelivery,
  type FlowAdvanceRequest,
  type MediaFetchRequest,
} from "@whatsapp-os/db";
import { SEND_JOB_OPTIONS } from "@whatsapp-os/core";
import { log } from "../logger.ts";
import { systemQueue } from "../queue.ts";

/**
 * Turn one delivered webhook into a conversation.
 *
 * The work itself is ingestWebhookDelivery, in packages/db, where it can be
 * proved against a real database - the ordering, the idempotency and the unread
 * count are all facts about constraints, and a mocked client would assert none
 * of them. What lives here is the half that needs a queue: enqueueing the media
 * downloads it asks for.
 *
 * The split is not only about testing. ingestWebhookDelivery has no queue in
 * scope, so it cannot make a network call while holding a company scope even by
 * accident, and every enqueue below happens after the last transaction has
 * closed.
 */
export async function handleWhatsAppWebhook(payload: WhatsAppWebhookJob): Promise<{
  status: string;
  inserted: number;
  advanced: number;
  media: number;
  flows: number;
}> {
  const { companyId, eventId } = payload;

  const summary = await ingestWebhookDelivery(companyId, eventId);

  for (const request of summary.media) {
    await enqueueMediaFetch(companyId, request);
  }

  /*
   * Flows, after the messages are written and with no scope open.
   *
   * Sequential rather than concurrent, and that is not caution about load. Two
   * taps from one customer in the same delivery are two answers to the same
   * run, and the second one is only meaningful once the first has moved the
   * position - run in parallel they would both read the run standing on the
   * same node and both be treated as live, which is exactly the double-advance
   * the button ids exist to prevent.
   */
  let flows = 0;

  for (const request of summary.flowAdvances) {
    flows += await advanceOneFlow(companyId, request);
  }

  /*
   * Verse, for the messages that are its to answer.
   *
   * Enqueued rather than answered here, unlike a flow advance. A flow's next
   * step is a lookup in a tree and finishes in milliseconds; an answer is an
   * embedding call, a vector search and a generation, and doing that inline
   * would hold the webhook handler open for seconds while Meta waits for a
   * 200 and retries the delivery it thinks failed.
   *
   * The job id is the message id, so two deliveries of the same customer
   * message produce one answer. BullMQ refuses a job whose id it already
   * holds, which for this job IS the deduplication.
   */
  for (const request of summary.verseReplies) {
    await systemQueue.add(
      JOB_NAMES.VERSE_REPLY,
      {
        companyId,
        conversationId: request.conversationId,
        messageId: request.messageId,
      },
      { jobId: verseReplyJobId(request.messageId) },
    );
  }

  /*
   * Meta told us a number's quality or tier moved. The third trigger for a
   * refresh, and the notification is treated as a reason to look rather than as
   * data: the job re-reads the whole account and writes what comes back.
   *
   * The job id collapses a burst - Meta sends one of these per number and they
   * arrive together - into a single Graph call for the delivery that carried
   * them.
   */
  if (summary.numberQualityUpdates > 0) {
    await systemQueue.add(
      JOB_NAMES.WHATSAPP_NUMBERS_REFRESH,
      { companyId },
      { jobId: `numbers:${companyId}:${eventId}` },
    );
  }

  const result = {
    status: summary.status,
    inserted: summary.inserted,
    advanced: summary.advanced,
    media: summary.media.length,
    flows,
  };

  log.info("webhook delivery ingested", {
    companyId,
    eventId,
    ...result,
    messages: summary.messages,
    statuses: summary.statuses,
    qualityUpdates: summary.numberQualityUpdates,
    /* Machine codes, and only the distinct ones - a batch of forty statuses for
       messages sent from Business Manager should be one line, not forty. */
    ...(summary.skipped.length > 0
      ? { skipped: [...new Set(summary.skipped)].join(",") }
      : {}),
  });

  return result;
}

/**
 * Advance one run, and hand whatever it produced to the send queue.
 *
 * Returns 1 when a run actually moved, so the log line distinguishes a
 * delivery that drove a flow from one that carried a tap this system declined.
 * A decline is logged at info with its machine reason: it is an ordinary
 * outcome - a customer scrolling up three days and pressing an old button -
 * and not an error, but it is also the thing somebody asks about when they say
 * the bot ignored them.
 */
async function advanceOneFlow(
  companyId: string,
  request: FlowAdvanceRequest,
): Promise<number> {
  const result = await advanceFlow(companyId, request);

  if (result.outcome === "no_flow") return 0;

  if (result.outcome === "declined") {
    log.info("flow tap declined", {
      companyId,
      messageId: request.messageId,
      reason: result.reason,
      ...(result.runId ? { runId: result.runId } : {}),
    });
    return 0;
  }

  for (const send of result.sends) {
    await systemQueue.add(
      JOB_NAMES.WHATSAPP_MESSAGE_SEND,
      {
        companyId,
        messageId: send.messageId,
        sendAttempt: send.sendAttempt,
      },
      {
        /*
         * The same id and the same options as every other send. A flow's
         * message is an ordinary outbound message, which is the whole point -
         * attempts: 1 included, because /messages has no idempotency key and a
         * retried question reaches a real customer twice.
         */
        jobId: sendJobId(send.messageId, send.sendAttempt),
        ...SEND_JOB_OPTIONS,
      },
    );
  }

  log.info("flow advanced", {
    companyId,
    runId: result.runId,
    outcome: result.outcome,
    sends: result.sends.length,
  });

  return 1;
}

async function enqueueMediaFetch(
  companyId: string,
  request: MediaFetchRequest,
): Promise<void> {
  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MEDIA_FETCH,
    {
      companyId,
      messageId: request.messageId,
      metaMediaId: request.metaMediaId,
    },
    {
      /*
       * Deterministic, so the two paths that can produce this request - a first
       * ingest and a redelivery that found the bytes still missing - collapse
       * into one job rather than downloading the same file twice.
       *
       * Keyed on the message and not on Meta's media id: the same photo
       * forwarded to fifty contacts is fifty messages, each needing its own row
       * linked, and the store deduplicates on the content hash afterwards.
       */
      jobId: `media:${request.messageId}`,
    },
  );
}
