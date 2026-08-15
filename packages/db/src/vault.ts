import { reseal, secretAad, type Keyring } from "@whatsapp-os/core";
import { withCompany } from "./with-company.ts";

/**
 * Re-encrypting a company's stored credentials under the active key.
 *
 * ---------------------------------------------------------------------------
 * Why this holds a row lock
 * ---------------------------------------------------------------------------
 *
 * Reseal reads a row, decrypts it, re-encrypts it and writes it back. Between
 * the read and the write there is a window, and an operator saving a new value
 * for that same credential lands in it:
 *
 *   reseal   reads R (key_id k1), decrypts to the old value
 *   save                          writes the NEW value under k2
 *   reseal   writes the OLD value re-encrypted under k2
 *
 * The save is gone. The row is valid, decrypts cleanly, carries the right
 * key_id, and holds the wrong secret — so no completion check notices, and the
 * discovery is a provider call failing weeks later with the correct-looking
 * credential in the database. With AAD there is no copy of the new value
 * anywhere to recover from.
 *
 * So the first statement inside each row's transaction is SELECT ... FOR
 * UPDATE. A concurrent save blocks for the microseconds the reseal takes, then
 * applies on top. An unlocked read plus a conditional UPDATE would not fix it:
 * the readback comparison would still be against a plaintext that was already
 * stale when it was read.
 *
 * That lock is the reason this file exists in packages/db rather than in the
 * worker — Prisma has no query-builder form of FOR UPDATE, so it is raw SQL,
 * and raw SQL against tenant rows belongs beside the other sanctioned sites.
 *
 * ---------------------------------------------------------------------------
 * One transaction per row
 * ---------------------------------------------------------------------------
 *
 * A batch transaction would hold locks across every credential a company has
 * and roll the whole set back for one bad row. Per row, a failure costs that
 * row and the rest still rotate — but the batch reports the failure rather
 * than looking clean.
 */

export interface ResealFailure {
  secretId: string;
  key: string;
  reason: string;
}

export interface ResealCounts {
  /** Rows re-encrypted under the active key. */
  resealed: number;
  /** Rows already on the active key when the lock was taken. */
  alreadyActive: number;
  failures: ResealFailure[];
}

interface LockedRow {
  id: string;
  integration_id: string;
  key: string;
  ciphertext: string;
  key_id: string;
}

export async function resealCompanySecrets(
  companyId: string,
  keyring: Keyring,
): Promise<ResealCounts> {
  /*
   * Candidates first, unlocked and outside any transaction. The list may be
   * stale by the time each row is reached, which is why the state that matters
   * is re-read under the lock below.
   */
  const candidates = await withCompany(companyId, (db) =>
    db.integrationSecret.findMany({
      where: { keyId: { not: keyring.activeId } },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
  );

  const counts: ResealCounts = { resealed: 0, alreadyActive: 0, failures: [] };

  for (const candidate of candidates) {
    let outcome: ResealOutcome;

    try {
      outcome = await resealOne(companyId, candidate.id, keyring);
    } catch (error) {
      /* A transaction-level fault — a lock timeout, a dropped connection. */
      outcome = { status: "failed", key: "", reason: describe(error) };
    }

    /*
     * A failure is recorded, never swallowed. A row whose key is missing would
     * otherwise survive the rotation, satisfy a key_id-based completion check,
     * and be discovered months later by a failing provider call with the key
     * material long since deleted.
     */
    if (outcome.status === "resealed") counts.resealed++;
    else if (outcome.status === "already-active") counts.alreadyActive++;
    else {
      counts.failures.push({
        secretId: candidate.id,
        key: outcome.key,
        reason: outcome.reason,
      });
    }
  }

  return counts;
}

/* Three members, not two: a `status: "a" | "b"` member does not narrow away. */
type ResealOutcome =
  | { status: "resealed" }
  | { status: "already-active" }
  | { status: "failed"; key: string; reason: string };

async function resealOne(
  companyId: string,
  secretId: string,
  keyring: Keyring,
): Promise<ResealOutcome> {
  return withCompany(companyId, async (db) => {
    /*
     * First statement, and the whole point of the transaction. RLS still
     * applies: this cannot lock another company's row, it simply finds none.
     */
    const rows = await db.$queryRaw<LockedRow[]>`
      SELECT id, integration_id, key, ciphertext, key_id
        FROM integration_secrets
       WHERE id = ${secretId}
       FOR UPDATE
    `;

    const row = rows[0];

    /* Deleted between listing and locking. Nothing to do, and not a failure. */
    if (!row) return { status: "already-active" };

    /* Saved under the active key while we were queuing for the lock. */
    if (row.key_id === keyring.activeId) return { status: "already-active" };

    if (!keyring.keys.has(row.key_id)) {
      /*
       * Named, and counted as a failure rather than skipped. This is exactly
       * the row vault:status reports as undecryptable, and the two must agree
       * — a rotation that quietly passed over it would report success while
       * leaving a credential nothing can open.
       */
      return {
        status: "failed",
        key: row.key,
        reason:
          `sealed with key "${row.key_id}", which is not in the keyring ` +
          `(have: ${[...keyring.keys.keys()].join(", ")}). Restore that key before rotating.`,
      };
    }

    try {
      /*
       * reseal() decrypts, re-encrypts and decrypts again, comparing before it
       * returns anything. An AAD built differently on the two sides would
       * otherwise produce a value nothing can ever open.
       */
      const resealed = reseal(
        row.ciphertext,
        keyring,
        secretAad(companyId, row.integration_id, row.key),
      );

      await db.integrationSecret.update({
        where: { id: row.id },
        data: { ciphertext: resealed, keyId: keyring.activeId },
      });

      return { status: "resealed" };
    } catch (error) {
      /* Caught here so the key name is still in scope for the report. */
      return { status: "failed", key: row.key, reason: describe(error) };
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
