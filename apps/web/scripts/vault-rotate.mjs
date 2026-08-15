/* First, and as its own module: ESM hoists imports, so a dotenv call at the
   top of this file would still run after lib/env.ts had already exited. */
import "./_load-env.mjs";

import { JOB_NAMES } from "@whatsapp-os/core";
import { listCompanyIdsWithSecrets } from "../lib/admin-db.ts";
import { keyring } from "../lib/integrations/seal.ts";
import { systemQueue } from "../lib/queue.ts";

/**
 * Re-encrypt every stored credential under the active key.
 *
 *     npm run vault:rotate -- --dry-run
 *     npm run vault:rotate
 *
 * Enumerates here and fans out one job per company, because the worker cannot
 * enumerate: it connects as app_runtime with no company context, so a
 * cross-company SELECT returns zero rows, succeeds, and looks exactly like
 * "nothing to do".
 *
 * ---------------------------------------------------------------------------
 * The guard at the top
 * ---------------------------------------------------------------------------
 *
 * keyring() throws if ENCRYPTION_KEY_ACTIVE names a key that is not in
 * ENCRYPTION_KEYS. That check has to happen before anything is enqueued: a
 * rotation toward a key that does not exist would have every worker fail on
 * its first row — or worse, if the key were added later with different
 * material, seal rows that nothing can open.
 *
 * One call, at the top, before the queue is touched.
 */

const dryRun = process.argv.includes("--dry-run");

/* Throws with a message naming the ids it does have. Deliberately first. */
const ring = keyring();

const companies = await listCompanyIdsWithSecrets();
const totalSecrets = companies.reduce((sum, row) => sum + row.secrets, 0);

console.log(`Active key: ${ring.activeId}`);
console.log(
  `${totalSecrets} credential(s) across ${companies.length} company/companies.`,
);

if (companies.length === 0) {
  console.log("Nothing to rotate.");
  process.exit(0);
}

if (dryRun) {
  console.log("\nDry run — nothing enqueued.\n");
  for (const row of companies) {
    console.log(`  ${row.companyId}: up to ${row.secrets} row(s) would move`);
  }
  console.log(
    "\nRows already on the active key are skipped under their own lock, so the\n" +
      "real figure is at most this.",
  );
  process.exit(0);
}

for (const row of companies) {
  await systemQueue.add(
    JOB_NAMES.VAULT_RESEAL,
    { companyId: row.companyId },
    /*
     * Deterministic, so running this twice in a row does not queue a second
     * pass over the same company. The reseal itself is idempotent, but two
     * passes take two sets of row locks for no reason.
     */
    { jobId: `reseal:${ring.activeId}:${row.companyId}` },
  );
  console.log(`  queued ${row.companyId}`);
}

console.log(
  `\nQueued ${companies.length} job(s).\n` +
    "Run npm run vault:status until it exits 0 before dropping the old key.",
);

await systemQueue.close();
