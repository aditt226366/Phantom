/* First, and as its own module: ESM hoists imports, so a dotenv call at the
   top of this file would still run after lib/env.ts had already exited. */
import "./_load-env.mjs";

import { auditVault, vaultIsHealthy } from "../lib/integrations/vault-audit.ts";
import { keyring } from "../lib/integrations/seal.ts";

/**
 * Is the vault readable?
 *
 *     npm run vault:status
 *
 * Exits 0 when every stored credential opens, and non-zero when any does not.
 *
 * ---------------------------------------------------------------------------
 * Why the exit code matters more than the output
 * ---------------------------------------------------------------------------
 *
 * The rotation procedure has to end with a step somebody can actually perform
 * correctly at the end of a long afternoon. "Confirm the counts look right" is
 * a judgement call, made by a tired person, about numbers they have not seen
 * before — and the failure mode is dropping a key that a handful of rows still
 * need, which is unrecoverable.
 *
 * So the gate is an exit code: run this, it must exit 0, then drop the key.
 * That is checkable, scriptable, and does not depend on anybody's attention.
 *
 * Never prints a plaintext. The audit asserts that decrypt succeeded and
 * discards the result; what is printed here is counts and coordinates.
 */

const ring = keyring();
const audit = await auditVault();

console.log(`Active key: ${ring.activeId}`);
console.log(`Keys in the keyring: ${[...ring.keys.keys()].join(", ")}`);
console.log(`Stored credentials: ${audit.total}`);

console.log("\nRows per key:");
if (Object.keys(audit.byKeyId).length === 0) {
  console.log("  (none)");
} else {
  for (const [keyId, count] of Object.entries(audit.byKeyId).sort()) {
    const active = keyId === ring.activeId ? " (active)" : "";
    const known = ring.keys.has(keyId) ? "" : "  ** NOT IN KEYRING **";
    console.log(`  ${keyId}: ${count}${active}${known}`);
  }
}

console.log(`\nFail to decrypt (key missing):        ${audit.missingKey}`);
console.log(`Do not match their coordinates (AAD): ${audit.badContext}`);

if (audit.problems.length > 0) {
  console.log("\nAffected rows:");
  for (const problem of audit.problems) {
    console.log(
      `  ${problem.reason}  company=${problem.companyId}` +
        `  integration=${problem.integrationId}  key=${problem.key}` +
        `  sealed_by=${problem.keyId}`,
    );
  }
}

if (!vaultIsHealthy(audit)) {
  console.error(
    "\nFAILED. Do not drop any key while rows above cannot be opened.\n" +
      "  missingKey  restore that key to ENCRYPTION_KEYS and re-run.\n" +
      "  badContext  the row does not match the company, integration and key\n" +
      "              name it now sits under. Re-enter that credential.",
  );
  process.exit(1);
}

const remaining = Object.entries(audit.byKeyId).filter(
  ([keyId]) => keyId !== ring.activeId,
);

if (remaining.length > 0) {
  console.log(
    `\nOK, but ${remaining.map(([id, n]) => `${n} row(s) on ${id}`).join(", ")}. ` +
      "Run npm run vault:rotate before dropping those keys.",
  );
} else {
  console.log("\nOK. Every credential opens, and all of them are on the active key.");
}
