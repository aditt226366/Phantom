/* First, and as its own module: ESM hoists imports, so a dotenv call at the
   top of this file would still run after lib/env.ts had already exited. */
import "./_load-env.mjs";

import { DASHBOARD_ROLLUP_INTERVAL_SECONDS } from "@whatsapp-os/core";
import { listAllCompanyIds } from "../lib/admin-db.ts";
import {
  scheduleDashboardRollup,
  unscheduleDashboardRollup,
} from "../lib/dashboard/scheduler.ts";
import { systemQueue } from "../lib/queue.ts";

/**
 * Give every company a dashboard rollup schedule.
 *
 *     npm run dashboard:schedule -- --dry-run
 *     npm run dashboard:schedule
 *
 * ---------------------------------------------------------------------------
 * Why a script and not a migration
 * ---------------------------------------------------------------------------
 *
 * The thing being created is not a row. It is a BullMQ job scheduler, which
 * lives in Redis, and a Prisma migration has no reach into Redis at all.
 *
 * ---------------------------------------------------------------------------
 * Why it enumerates here rather than in the worker
 * ---------------------------------------------------------------------------
 *
 * The same reason vault-rotate.mjs and the repair fan-out do. The worker
 * connects as app_runtime with no company context, so `SELECT id FROM
 * companies` returns zero rows, succeeds, and looks exactly like "no companies
 * to refresh". Only app_admin can enumerate, only lib/admin-db.ts may hold that
 * client, and this reads through a named function there.
 *
 * ---------------------------------------------------------------------------
 * Safe to run repeatedly, which is the whole point of the id
 * ---------------------------------------------------------------------------
 *
 * upsertJobScheduler keys on a deterministic id derived from the company id, so
 * a second run replaces each schedule rather than adding one. Without that a
 * re-run would double every company's refresh rate, and nothing would report
 * it - the dashboard would look right and the database would be doing twice the
 * work for ever.
 *
 * Run it after a deploy that adds this phase, and again any time a signup may
 * have been unable to reach Redis - registration there is deliberately
 * non-fatal, so a Redis outage during a signup leaves exactly this gap.
 */

const dryRun = process.argv.includes("--dry-run");
/*
 * Removes a scheduler whose company no longer exists. Off by default: the
 * comparison it depends on is only sound when this script can see every
 * company, and pointing it at the wrong database would unregister everything.
 */
const prune = process.argv.includes("--prune");

const companyIds = await listAllCompanyIds();

console.log(
  `${companyIds.length} company/companies, refreshing every ` +
    `${DASHBOARD_ROLLUP_INTERVAL_SECONDS}s.`,
);

/*
 * What is already registered, so the report distinguishes "added" from
 * "already there". The upsert makes them behave identically; a person running
 * this after an incident wants to know which it was.
 */
const existing = await systemQueue.getJobSchedulers(0, -1, "asc");
const known = new Set(
  existing
    .map((scheduler) => scheduler.key)
    .filter((key) => typeof key === "string" && key.startsWith("dashboard-rollup:")),
);

const missing = companyIds.filter(
  (companyId) => !known.has(`dashboard-rollup:${companyId}`),
);

const orphaned = [...known].filter(
  (key) => !companyIds.includes(key.slice("dashboard-rollup:".length)),
);

console.log(`  ${known.size} already registered`);
console.log(`  ${missing.length} to add`);
if (orphaned.length > 0) {
  console.log(
    `  ${orphaned.length} scheduler(s) name a company that does not exist` +
      (prune ? " — removing" : " — pass --prune to remove"),
  );
}

if (dryRun) {
  console.log("\nDry run — nothing written.\n");
  for (const companyId of missing) console.log(`  + ${companyId}`);
  for (const key of orphaned) console.log(`  - ${key}`);
  await systemQueue.close();
  process.exit(0);
}

/*
 * Every company, not only the missing ones. The upsert is idempotent and this
 * is also how an interval change is rolled out - a run that skipped the ones it
 * believed were correct would leave every existing company on the old schedule.
 */
for (const companyId of companyIds) {
  await scheduleDashboardRollup(companyId);
}

if (prune) {
  for (const key of orphaned) {
    await unscheduleDashboardRollup(key.slice("dashboard-rollup:".length));
  }
}

console.log(`\nRegistered ${companyIds.length} schedule(s).`);

await systemQueue.close();
process.exit(0);
