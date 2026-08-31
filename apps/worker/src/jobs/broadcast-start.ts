import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  broadcastStartJobId,
  sendJobId,
  type BroadcastStartJob,
} from "@whatsapp-os/core";
import { sendDelayMs } from "@whatsapp-os/core/bulk";
import { fillVariables } from "@whatsapp-os/core/whatsapp";
import {
  RECIPIENT_BATCH,
  broadcastForRun,
  broadcastRunState,
  completeBroadcastIfDone,
  materialiseRecipient,
  pendingRecipients,
  skipRecipient,
  withCompany,
} from "@whatsapp-os/db";
import { systemQueue } from "../queue.ts";
import { log } from "../logger.ts";

/**
 * Turn a broadcast's audience into messages and schedule every send.
 *
 * ---------------------------------------------------------------------------
 * The schedule is computed once and handed to BullMQ, not ticked
 * ---------------------------------------------------------------------------
 *
 * Every recipient's send is enqueued here with a `delay` of index * gap. That
 * makes the whole run deterministic and restart-proof: the queue holds the
 * plan, so a worker that dies and comes back finds every remaining send still
 * due at the time it was always going to be due. There is no scheduler, no
 * ticking loop, and nothing to catch up on.
 *
 * The alternative - a job that sends one and re-enqueues itself - is a chain
 * where every link is a chance to lose the rest of the campaign.
 *
 * ---------------------------------------------------------------------------
 * Batched, and re-runnable
 * ---------------------------------------------------------------------------
 *
 * Recipients are claimed in batches of 500 and each batch is its own short
 * scope, because withCompany holds a pooled connection and times out after
 * five seconds. Claiming is a state change from PENDING to SENT, so this job
 * dying half way through and being retried picks up where it stopped rather
 * than scheduling the first half twice.
 *
 * "SENT" on the recipient means "handed to the queue", not "Meta took it".
 * What Meta said is on the message row, which is the only place that question
 * has ever been answered.
 */
export type BroadcastStartResult =
  | "scheduled"
  | "not_found"
  | "not_runnable"
  | "template_not_approved";

export async function handleBroadcastStart(
  payload: BroadcastStartJob,
): Promise<{ result: BroadcastStartResult; scheduled: number }> {
  const { companyId, broadcastId } = payload;

  const broadcast = await withCompany(companyId, (db, scoped) =>
    broadcastForRun(db, scoped, broadcastId),
  );

  if (!broadcast) return { result: "not_found", scheduled: 0 };

  if (broadcast.status !== "RUNNING") {
    /* Paused or cancelled between the action and this job. Nothing to undo -
       no message rows exist yet for anything not already scheduled. */
    log.info("broadcast not runnable at start", {
      companyId,
      broadcastId,
      status: broadcast.status,
    });
    return { result: "not_runnable", scheduled: 0 };
  }

  /*
   * Approval is checked once, here, rather than per recipient.
   *
   * Meta re-checks on every send anyway and a withdrawal mid-run comes back as
   * a refusal with its own reason - but scheduling ten thousand sends of a
   * template that is already rejected would burn the number's rating for no
   * possible benefit, and the tenant would watch a report fill with identical
   * failures.
   */
  if (broadcast.template.status !== "APPROVED") {
    log.warn("broadcast template is not approved", {
      companyId,
      broadcastId,
      status: broadcast.template.status,
    });
    return { result: "template_not_approved", scheduled: 0 };
  }

  const body = extractBody(broadcast.template.components);
  let scheduled = payload.scheduledSoFar;

  for (;;) {
    /*
     * Re-read the run state every batch. A pause pressed while ten thousand
     * recipients are being scheduled has to stop the scheduling too, not only
     * the sending - otherwise Pause leaves a queue that keeps draining for the
     * next two hours.
     */
    const state = await withCompany(companyId, (db, scoped) =>
      broadcastRunState(db, scoped, broadcastId),
    );

    if (state !== "runnable") {
      log.info("broadcast scheduling stopped", {
        companyId,
        broadcastId,
        state,
        scheduled,
      });
      return { result: "not_runnable", scheduled };
    }

    const batch = await withCompany(companyId, (db, scoped) =>
      pendingRecipients(db, scoped, broadcastId, RECIPIENT_BATCH),
    );

    if (batch.length === 0) break;

    for (const recipient of batch) {
      const now = new Date();

      const materialised = await withCompany(companyId, (db, scoped) =>
        materialiseRecipient(db, scoped, {
          recipientId: recipient.id,
          broadcastId,
          whatsappNumberId: broadcast.whatsappNumberId,
          phoneE164: recipient.phoneE164,
          variables: recipient.variables,
          template: {
            name: broadcast.template.name,
            language: broadcast.template.language,
            body,
          },
          renderedBody: fillVariables(body, recipient.variables),
          occurredAt: now,
          createdByUserId: broadcast.createdByUserId,
        }),
      );

      if (!materialised) {
        /*
         * Opted out or undeliverable since the import. No message row was
         * created, so the recipient is marked here with the reason a report
         * will show - the alternative is a row that silently disappears from
         * the counts.
         */
        await withCompany(companyId, (db, scoped) =>
          skipRecipient(
            db,
            scoped,
            recipient.id,
            "Opted out or unreachable since this list was imported",
          ),
        );
        continue;
      }

      await systemQueue.add(
        JOB_NAMES.WHATSAPP_MESSAGE_SEND,
        {
          companyId,
          messageId: materialised.messageId,
          sendAttempt: materialised.sendAttempt,
        },
        {
          jobId: sendJobId(materialised.messageId, materialised.sendAttempt),
          ...SEND_JOB_OPTIONS,
          /*
           * The pacing, and the only place it is applied. `scheduled` counts
           * every recipient handed to the queue in this run INCLUDING those of
           * an earlier pass, which is why a resume carries scheduledSoFar - a
           * resume that restarted at zero would send the whole remainder in
           * one burst, which is the single thing the gap exists to prevent.
           */
          delay: sendDelayMs(scheduled, broadcast.gapMs),
        },
      );

      scheduled += 1;
    }
  }

  const completed = await withCompany(companyId, (db, scoped) =>
    completeBroadcastIfDone(db, scoped, broadcastId, new Date()),
  );

  log.info("broadcast scheduled", {
    companyId,
    broadcastId,
    scheduled,
    /* True only when every recipient was skipped - otherwise the sends are
       still in flight and the last one to land completes it. */
    completedImmediately: completed,
  });

  return { result: "scheduled", scheduled };
}

/** Re-enqueue the remainder of a paused broadcast. */
export function resumeJobId(broadcastId: string, run: number): string {
  return broadcastStartJobId(broadcastId, run);
}

/** The BODY text out of a stored component array, or empty if there is none. */
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return "";

  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as Record<string, unknown>)["type"] === "BODY"
    ) {
      const text = (component as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
    }
  }

  return "";
}
