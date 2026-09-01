import {
  dashboardWindows,
  type DashboardRollupJob,
} from "@whatsapp-os/core";
import { refreshDashboardRollup, withCompany } from "@whatsapp-os/db";
import { log } from "../logger.ts";

/**
 * Recompute one company's dashboard figures.
 *
 * ---------------------------------------------------------------------------
 * The whole handler is one transaction, and that is not the usual advice
 * ---------------------------------------------------------------------------
 *
 * withCompany holds a pooled connection and Prisma times it out after five
 * seconds, so most handlers here are careful to do as little inside it as
 * possible - lead-source.poll opens three separate short scopes around an HTTP
 * call for exactly that reason.
 *
 * This one is the opposite case and deliberately so. There is no HTTP call, no
 * hashing and no decryption; there is one statement. Splitting it would mean
 * several statements over several snapshots, which is the thing the rollup
 * exists to avoid: the computed_at written beside the figures has to be a
 * moment all of them were simultaneously true.
 *
 * If it ever does approach five seconds on a real tenant, the answer is an
 * index or a narrower window - not a longer timeout and not a split. A refresh
 * slow enough to need a raised timeout is one that would be blocking a
 * connection every sixty seconds for every company at once.
 *
 * ---------------------------------------------------------------------------
 * The bounds are computed here, at run time
 * ---------------------------------------------------------------------------
 *
 * Not at registration. A repeatable job's data is frozen when the scheduler is
 * created, so a day boundary in the payload would pin "today" to the day the
 * company signed up - permanently, and with every card under that heading
 * quietly describing it.
 *
 * ---------------------------------------------------------------------------
 * Failure is ordinary and the retry is the default five
 * ---------------------------------------------------------------------------
 *
 * Unlike a send, nothing here reaches a customer and nothing is charged, so a
 * retry costs a scan. And unlike a poll, there is no external quota to back off
 * from. A failed refresh leaves the previous row in place, which is exactly
 * what the freshness stamp is for: the page keeps showing the older figures and
 * says how old they are, rather than showing nothing or showing zeroes.
 */
export async function handleDashboardRollup(
  job: DashboardRollupJob,
): Promise<{ companyId: string; computedAt: string }> {
  const windows = dashboardWindows();

  /*
   * companyId comes from the job payload - CLAUDE.md rule 3's third origin. It
   * is here because a server action put it here after requireSession(), or
   * because the backfill script read it through the admin client. Nothing
   * outside this system writes to the queue.
   */
  await withCompany(job.companyId, (db) =>
    refreshDashboardRollup(db, {
      computedAt: windows.now,
      dayStart: windows.dayStart,
      monthStart: windows.monthStart,
    }),
  );

  log.info("dashboard.rollup refreshed", {
    companyId: job.companyId,
    /*
     * The day boundary in the log line, not just the instant. When a "new
     * today" figure is disputed, the question is always which day the count
     * was taken against, and reconstructing that from a timestamp and a
     * timezone rule after the fact is exactly the work this saves.
     */
    dayStart: windows.dayStart.toISOString(),
  });

  return {
    companyId: job.companyId,
    computedAt: windows.now.toISOString(),
  };
}
