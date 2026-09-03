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
  /**
   * What the provider said this call consumed, when it says anything.
   *
   * Omitted rather than zeroed by every caller that has no tokens - a Graph
   * call has none, and writing 0 would claim it consumed nothing. Passed
   * straight through from the adapter's own `VerseUsage` so nothing here can
   * disagree with what the provider returned.
   *
   * See the column comments in schema.prisma for why these are recorded at all
   * before anything prices them, and for the cache split that will eventually
   * make `inputTokens` less than the billable input.
   */
  usage?: {
    inputTokens: number;
    /**
     * Omitted where the concept does not apply, which is embeddings.
     *
     * An embedding's output is a vector, not tokens, so OpenAI reports no
     * completion half and there is nothing to record. Writing 0 would claim the
     * call produced none of something it cannot produce - the same lie as a
     * zero cost on an unpriced row, one column along. output_tokens stays NULL
     * for verse.embedding, permanently and correctly.
     */
    outputTokens?: number;
  };
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
        /*
         * Spread only when present, so a caller with no tokens leaves both
         * columns NULL rather than writing a zero it did not measure. The same
         * shape `occurredAt` uses above and for the same reason: absent is a
         * different fact from a default.
         */
        ...(input.usage ? { inputTokens: input.usage.inputTokens } : {}),
        /*
         * Independently of the input half, because embeddings have one and not
         * the other. Spreading them together would force a caller with only an
         * input count to supply a zero output, which is exactly the claim this
         * column refuses to let anybody make by accident.
         */
        ...(input.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: input.usage.outputTokens }),
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
