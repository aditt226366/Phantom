import { priceUsage, type UsageKind } from "@whatsapp-os/core";
import type { CompanyClient } from "./with-company.ts";

/**
 * Recording what a company used, priced at the moment it happened.
 *
 * Takes a `db` rather than opening its own scope, like auditWithin: the usage
 * row belongs in the same transaction as the thing it describes, so a rolled
 * back verification does not leave a charge behind.
 *
 * ---------------------------------------------------------------------------
 * Never the reason a call fails
 * ---------------------------------------------------------------------------
 *
 * Two things follow from that, and both are deliberate.
 *
 * An unpriced kind writes a null cost and a reason rather than throwing. The
 * provider call already happened; refusing to record it because a price list
 * is incomplete loses the event permanently, and usage that was never recorded
 * cannot be reconstructed. Null is also not zero - zero claims the event was
 * free, null records that no claim was made, and only one of those is honest
 * about a missing price entry.
 *
 * A duplicate is skipped rather than raised. DEFAULT_JOB_OPTIONS sets
 * attempts: 5, so a job that records usage and then fails runs this again;
 * without the constraint that is five charges for one provider call, and with
 * a constraint but no skip it is an exception thrown from the retry path of
 * something that already worked.
 */

export interface RecordUsageInput {
  kind: UsageKind;
  /**
   * The idempotency key. Build it with usageDedupeKey() from something stable
   * about the work - a job id and the row it acted on, not a timestamp.
   */
  dedupeKey: string;
  /** Defaults to 1. Multiplied by the unit price. */
  quantity?: number;
  /** Defaults to now. A retry should pass the original moment, not its own. */
  occurredAt?: Date;
}

export interface RecordedUsage {
  /** False when an identical dedupe key was already present. */
  recorded: boolean;
  /** Null when nothing priced this kind. */
  costMicros: bigint | null;
  currency: string | null;
  unpricedReason: string | null;
}

export async function recordUsage(
  db: CompanyClient,
  companyId: string,
  input: RecordUsageInput,
): Promise<RecordedUsage> {
  const quantity = input.quantity ?? 1;

  /* Currency comes from the entry, never from the caller. Shared with the
     admin-side emitter so the two cannot price the same event differently. */
  const priced = priceUsage(input.kind, quantity);

  /*
   * createMany with skipDuplicates, which is ON CONFLICT DO NOTHING. A
   * findFirst-then-create would race two retries against each other and lose,
   * because the check and the write are two statements.
   */
  const { count } = await db.usageEvent.createMany({
    data: [
      {
        companyId,
        kind: input.kind,
        quantity,
        dedupeKey: input.dedupeKey,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...priced,
      },
    ],
    skipDuplicates: true,
  });

  return {
    recorded: count > 0,
    costMicros: priced.costMicros,
    currency: priced.currency,
    unpricedReason: priced.unpricedReason,
  };
}
