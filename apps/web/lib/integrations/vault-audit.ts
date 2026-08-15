import "server-only";
import { keyIdOf } from "@whatsapp-os/core";
import { listAllSealedSecrets } from "@/lib/admin-db";
import { keyring, open } from "./seal";

/**
 * Can every stored credential still be opened?
 *
 * ---------------------------------------------------------------------------
 * Why key-id counts are not enough
 * ---------------------------------------------------------------------------
 *
 * A rotation reports how many rows moved onto the active key, and that number
 * can be perfect while the vault is broken. A row can carry the right key_id
 * and still not open — because the ciphertext was written under an AAD that no
 * longer matches its coordinates, or because it was corrupted on the way in.
 * Counting key ids sees none of that.
 *
 * So the check opens every row. The assertion is that decrypt *succeeded*; the
 * plaintext is discarded on the next line and never counted, printed, returned
 * or logged. Nothing here has a reason to know what a credential says, only
 * that it is still readable.
 *
 * Two failure kinds, because they need different responses:
 *
 *   missingKey   the key that sealed it is not in the keyring. Restore that
 *                key. Nothing else will open the row, ever.
 *   badContext   the key is present and the ciphertext is well-formed, but the
 *                tag does not verify — the row does not match the company,
 *                integration and key name it now sits under. It was moved, or
 *                the AAD construction changed.
 */

export interface VaultAudit {
  total: number;
  /** How many rows each key currently seals. */
  byKeyId: Record<string, number>;
  missingKey: number;
  badContext: number;
  /** Enough to find each bad row. Never a value. */
  problems: Array<{
    companyId: string;
    integrationId: string;
    key: string;
    keyId: string;
    reason: "missingKey" | "badContext";
  }>;
}

export async function auditVault(): Promise<VaultAudit> {
  const ring = keyring();
  const rows = await listAllSealedSecrets();

  const audit: VaultAudit = {
    total: rows.length,
    byKeyId: {},
    missingKey: 0,
    badContext: 0,
    problems: [],
  };

  for (const row of rows) {
    /* From the wire, not the column: they can disagree, and the wire wins. */
    let sealedBy: string;
    try {
      sealedBy = keyIdOf(row.ciphertext);
    } catch {
      sealedBy = row.keyId;
    }

    audit.byKeyId[sealedBy] = (audit.byKeyId[sealedBy] ?? 0) + 1;

    if (!ring.keys.has(sealedBy)) {
      audit.missingKey++;
      audit.problems.push({
        companyId: row.companyId,
        integrationId: row.integrationId,
        key: row.key,
        keyId: sealedBy,
        reason: "missingKey",
      });
      continue;
    }

    try {
      /* The result is deliberately unused. Success is the entire assertion. */
      open(row.companyId, row.integrationId, row.key, row.ciphertext);
    } catch {
      audit.badContext++;
      audit.problems.push({
        companyId: row.companyId,
        integrationId: row.integrationId,
        key: row.key,
        keyId: sealedBy,
        reason: "badContext",
      });
    }
  }

  return audit;
}

/** The gate: a key may be dropped only when this is true. */
export function vaultIsHealthy(audit: VaultAudit): boolean {
  return audit.missingKey === 0 && audit.badContext === 0;
}
