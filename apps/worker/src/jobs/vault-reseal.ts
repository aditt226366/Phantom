import type { VaultResealJob } from "@whatsapp-os/core";
import { resealCompanySecrets } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Re-encrypt one company's credentials under the active key.
 *
 * One company per job, because the worker cannot enumerate them: it connects
 * as app_runtime with no company context, so a cross-company SELECT returns
 * zero rows, succeeds, and looks exactly like "nothing to do". The fan-out is
 * done on the web side, which holds the admin client.
 *
 * Safe to re-run. Rows already on the active key are skipped under their own
 * lock, so a retry after a crash resumes rather than repeating work.
 */
export async function handleVaultReseal(
  payload: VaultResealJob,
): Promise<{ resealed: number; alreadyActive: number; failed: number }> {
  const counts = await resealCompanySecrets(payload.companyId, keyring());

  const summary = {
    companyId: payload.companyId,
    resealed: counts.resealed,
    alreadyActive: counts.alreadyActive,
    failed: counts.failures.length,
  };

  if (counts.failures.length === 0) {
    log.info("vault reseal complete", summary);
    return summary;
  }

  /*
   * A partial rotation must not look like a finished one.
   *
   * The failure that matters is a row sealed with a key that is no longer in
   * the keyring. Reporting success would let an operator see "rotated", check
   * that nothing remains on the old key, and drop it — destroying the only
   * thing that could still open that row. So this logs at error level and
   * throws, which marks the job failed and puts it where somebody looks.
   *
   * Key names only; the reasons name a key id, never a value.
   */
  log.error("vault reseal finished with failures", {
    ...summary,
    failures: counts.failures.map((failure) => ({
      key: failure.key,
      reason: failure.reason,
    })),
  });

  throw new Error(
    `Reseal for company ${payload.companyId} left ${counts.failures.length} ` +
      `secret(s) unrotated. First: ${counts.failures[0]?.key} — ${counts.failures[0]?.reason}`,
  );
}
