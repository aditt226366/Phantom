import "server-only";
import {
  DASHBOARD_ROLLUP_INTERVAL_SECONDS,
  JOB_NAMES,
  dashboardRollupSchedulerId,
} from "@whatsapp-os/core";
import { systemQueue } from "@/lib/queue";

/**
 * Registering one company's rollup refresh.
 *
 * The third instance of the pattern lead-sources/scheduler.ts describes, and
 * the reasoning is unchanged: the worker connects as app_runtime with no
 * company context, so it cannot enumerate companies. A single sweeping refresh
 * would select zero rows, succeed, and look exactly like "nothing to do" - and
 * because the failure is silent, the symptom would be a dashboard that is
 * simply always wrong rather than one that is visibly broken.
 *
 * So the fan-out happens here, on the side that has a company id it is allowed
 * to serialise into a job. That is CLAUDE.md rule 3's third origin.
 */

/**
 * Register, or re-register, a company's refresh.
 *
 * Idempotent by the id, which is what makes it safe to call from two places.
 * `upsertJobScheduler` keys on the id, so a signup that registers one and a
 * backfill run that registers it again replace each other rather than
 * accumulating - a company refreshing twice a minute would pay for both scans
 * and neither would be wrong, which is precisely the kind of waste nobody ever
 * notices.
 *
 * Failure is deliberately not caught here. The one caller that must not fail
 * because of this - signup - handles it itself and says why.
 */
export async function scheduleDashboardRollup(companyId: string): Promise<void> {
  await systemQueue.upsertJobScheduler(
    dashboardRollupSchedulerId(companyId),
    { every: DASHBOARD_ROLLUP_INTERVAL_SECONDS * 1000 },
    {
      name: JOB_NAMES.DASHBOARD_ROLLUP,
      data: { companyId },
    },
  );
}

/**
 * Stop refreshing a company's dashboard.
 *
 * Not wired to deactivation, and that is a decision rather than an omission. A
 * deactivated company's operator cannot sign in, so nothing reads the rollup -
 * but the platform admin can still look at the workspace, and a suspension that
 * silently froze the numbers would leave the panel showing figures from the day
 * of the suspension with nothing to say so. The cost of continuing is one
 * indexed scan a minute.
 *
 * It exists for deletion, where the row is going away by CASCADE and a
 * scheduler that outlives it wakes every minute for ever, finds a company that
 * is not there, and logs a failure on every tick.
 */
export async function unscheduleDashboardRollup(
  companyId: string,
): Promise<void> {
  await systemQueue.removeJobScheduler(dashboardRollupSchedulerId(companyId));
}
