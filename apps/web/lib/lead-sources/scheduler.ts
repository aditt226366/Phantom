import "server-only";
import { JOB_NAMES, leadSourceSchedulerId } from "@whatsapp-os/core";
import { systemQueue } from "@/lib/queue";

/**
 * Registering and removing one binding's poll.
 *
 * The worker cannot enumerate companies - it connects as app_runtime with no
 * company context, so a sweeping poller would select zero rows, succeed, and
 * look exactly like "nothing to do". So the fan-out happens here, on the side
 * that has just resolved a session and therefore has a company id it is
 * allowed to serialise into a job.
 *
 * That is CLAUDE.md rule 3's third origin, and this file is the producer it
 * names. The company id in the payload is trusted downstream entirely because
 * this ran after requireSession().
 */

/**
 * Register or re-register a binding's poll.
 *
 * An upsert on a deterministic id, which is the part that matters. Changing the
 * interval re-registers under the same key and REPLACES the schedule; a random
 * or timestamped id would leave the old one running, and the binding would
 * quietly poll twice as often. That is every other tenant's quota problem
 * before it is a visible problem for this one, because Sheets meters reads per
 * project rather than per customer.
 */
export async function scheduleLeadSourcePoll(input: {
  companyId: string;
  leadSourceId: string;
  intervalSeconds: number;
}): Promise<void> {
  await systemQueue.upsertJobScheduler(
    leadSourceSchedulerId(input.leadSourceId),
    { every: input.intervalSeconds * 1000 },
    {
      name: JOB_NAMES.LEAD_SOURCE_POLL,
      data: {
        companyId: input.companyId,
        leadSourceId: input.leadSourceId,
      },
    },
  );
}

/**
 * Stop polling a binding for good.
 *
 * Called when a binding is deleted. A scheduler that outlives its row wakes
 * every thirty seconds for ever, finds nothing, and logs a not-found on every
 * tick - which is noise that buries the log line somebody actually needs.
 *
 * Deliberately NOT called when a binding is paused. The job keeps ticking and
 * the handler returns early on a status that is not ACTIVE, so re-enabling is
 * one UPDATE rather than a re-registration that could fail and leave a binding
 * that says ACTIVE and polls nothing - which is the worst of the three states
 * because it looks correct.
 */
export async function unscheduleLeadSourcePoll(
  leadSourceId: string,
): Promise<void> {
  await systemQueue.removeJobScheduler(leadSourceSchedulerId(leadSourceId));
}
