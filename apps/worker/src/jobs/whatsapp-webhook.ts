import { JOB_NAMES, type WhatsAppWebhookJob } from "@whatsapp-os/core";
import { ingestWebhookDelivery, type MediaFetchRequest } from "@whatsapp-os/db";
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
export async function handleWhatsAppWebhook(
  payload: WhatsAppWebhookJob,
): Promise<{ status: string; inserted: number; advanced: number; media: number }> {
  const { companyId, eventId } = payload;

  const summary = await ingestWebhookDelivery(companyId, eventId);

  for (const request of summary.media) {
    await enqueueMediaFetch(companyId, request);
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
