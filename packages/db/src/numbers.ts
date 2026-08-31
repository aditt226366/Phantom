import type { WhatsAppNumberFacts } from "@whatsapp-os/core/whatsapp";
import type { WhatsAppQualityRating } from "./generated/prisma/enums.ts";
import type { CompanyClient } from "./with-company.ts";

/**
 * Writing what Meta said about a company's numbers, including what it did not
 * say.
 *
 * The cache half is ordinary: upsert each number Meta returned and stamp
 * metadata_refreshed_at, so the page can show the age of the answer rather than
 * fetching one itself.
 *
 * The interesting half is absence. See applyNumberRefresh.
 */

export interface NumberRefreshCounts {
  /** Numbers Meta returned, whether or not anything about them changed. */
  refreshed: number;
  /** Numbers Meta returned that we had never seen. */
  added: number;
  /** Numbers we hold that Meta did not return this time. */
  missing: number;
  /** Numbers that were marked missing and have come back. */
  restored: number;
}

/** The only reason a number is marked missing today. A code, never prose. */
export const MISSING_FROM_META_LIST = "absent_from_meta_list";

/**
 * Apply one fetch to the stored numbers.
 *
 * ---------------------------------------------------------------------------
 * A number Meta stopped returning is marked, never deleted
 * ---------------------------------------------------------------------------
 *
 * Deleting is the obvious response to a number that is no longer in the list,
 * and it is wrong. "Removed in Business Manager" and "one API call came back
 * short" are the same event from here - an absence - and only one of them is
 * real. Meta pages, tokens lose scope, and an account can be briefly
 * unreadable without an error the caller can see.
 *
 * Deleting on the wrong one takes the row and every conversation that
 * references it, on the evidence of a field not being present. So absence is
 * recorded as a fact about this refresh:
 *
 *   missing_since   set on the FIRST refresh that missed it, and left alone by
 *                   later ones - two minutes missing and two weeks missing are
 *                   different situations, and only the first-seen timestamp can
 *                   tell them apart
 *   missing_reason  why, as a code
 *
 * Both are cleared the instant Meta returns the number again, which is what
 * makes a transient absence self-correcting rather than a permanent mark.
 * Removing a number stays a deliberate act by a person who knows whether they
 * removed it.
 */
export async function applyNumberRefresh(
  db: CompanyClient,
  companyId: string,
  integrationId: string,
  fetched: readonly WhatsAppNumberFacts[],
  now: Date,
): Promise<NumberRefreshCounts> {
  const existing = await db.whatsAppNumber.findMany({
    where: { integrationId },
    select: { id: true, phoneNumberId: true, missingSince: true },
  });

  const known = new Map(existing.map((row) => [row.phoneNumberId, row]));
  const counts: NumberRefreshCounts = {
    refreshed: 0,
    added: 0,
    missing: 0,
    restored: 0,
  };

  /*
   * qualityRating is cast rather than re-validated. fetchWhatsAppNumbers
   * normalises to exactly this enum's members, so checking again here would be
   * a second copy of a closed set and a second answer for what to do when it
   * fails - and the column could not hold the failure anyway.
   */
  for (const number of fetched) {
    const before = known.get(number.phoneNumberId);

    await db.whatsAppNumber.upsert({
      where: {
        companyId_phoneNumberId: { companyId, phoneNumberId: number.phoneNumberId },
      },
      create: {
        companyId,
        integrationId,
        phoneNumberId: number.phoneNumberId,
        displayNumber: number.displayNumber,
        verifiedName: number.verifiedName,
        qualityRating: number.qualityRating as WhatsAppQualityRating,
        status: number.status,
        messagingTier: number.messagingTier,
        throughputLevel: number.throughputLevel,
        metadataRefreshedAt: now,
      },
      /*
       * companyId named explicitly - R3. The extension merges it into `where`
       * and into `create`, and NOT into `update`.
       *
       * The two missing_* columns are cleared unconditionally rather than only
       * when set. Meta returning the number IS the evidence that it is not
       * missing, and a conditional write here would be a second rule to keep in
       * step with the one below.
       */
      update: {
        companyId,
        integrationId,
        displayNumber: number.displayNumber,
        verifiedName: number.verifiedName,
        qualityRating: number.qualityRating as WhatsAppQualityRating,
        status: number.status,
        messagingTier: number.messagingTier,
        throughputLevel: number.throughputLevel,
        metadataRefreshedAt: now,
        missingSince: null,
        missingReason: null,
      },
    });

    counts.refreshed++;
    if (!before) counts.added++;
    else if (before.missingSince) counts.restored++;
  }

  const returned = new Set(fetched.map((number) => number.phoneNumberId));

  for (const row of existing) {
    if (returned.has(row.phoneNumberId)) continue;

    counts.missing++;

    /*
     * Already marked, so the timestamp stays where it was. Overwriting it every
     * refresh would reset the clock on a number that has been gone for a week
     * and make a long absence indistinguishable from a new one - which is the
     * only thing the column is for.
     */
    if (row.missingSince) continue;

    await db.whatsAppNumber.update({
      where: { id: row.id },
      data: { missingSince: now, missingReason: MISSING_FROM_META_LIST },
    });
  }

  return counts;
}
