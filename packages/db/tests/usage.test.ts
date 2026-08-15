import { ACTIVE_PRICE_VERSION, usageDedupeKey } from "@whatsapp-os/core";
import { beforeEach, describe, expect, it } from "vitest";
import { recordUsage, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The emitter, against a real database, because every property worth asserting
 * here is enforced by the database rather than by the function: the unique
 * constraint, the nullability of the cost column, and what SUM does with a
 * null.
 */

let company: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("usage");
});

/** Rows as stored, read raw so nothing is reinterpreted on the way out. */
async function rows(): Promise<
  Array<{
    kind: string;
    quantity: number;
    cost_micros: bigint | null;
    currency: string | null;
    price_version: number;
    unpriced_reason: string | null;
    dedupe_key: string;
  }>
> {
  return withCompany(company.id, (db) => db.$queryRaw`
    SELECT kind, quantity, cost_micros, currency, price_version,
           unpriced_reason, dedupe_key
      FROM usage_events ORDER BY dedupe_key
  `);
}

describe("recordUsage", () => {
  it("prices a known kind from the price entry", async () => {
    const result = await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, {
        kind: "integration.verify",
        dedupeKey: usageDedupeKey("integration.verify", "job1", "int1"),
      }),
    );

    expect(result.recorded).toBe(true);
    expect(result.currency).toBe("INR");
    expect(result.unpricedReason).toBeNull();

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.currency).toBe("INR");
    expect(stored[0]?.price_version).toBe(ACTIVE_PRICE_VERSION);
    expect(stored[0]?.unpriced_reason).toBeNull();
  });

  it("multiplies the unit price by quantity", async () => {
    /* Zero-priced today, so assert the arithmetic rather than the total. */
    const result = await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, {
        kind: "integration.verify",
        dedupeKey: "q",
        quantity: 7,
      }),
    );

    expect(result.costMicros).toBe(0n);
    expect((await rows())[0]?.quantity).toBe(7);
  });

  it("writes a null cost and a reason for an unpriced kind", async () => {
    /*
     * The amendment that matters. A missing price entry writing 0 is
     * indistinguishable from a genuinely free event once summed, and the
     * figure still renders as though it were authoritative.
     */
    const result = await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, {
        /* Deliberately outside USAGE_KINDS. */
        kind: "ai.reply" as never,
        dedupeKey: "unpriced-1",
      }),
    );

    expect(result.recorded).toBe(true);
    expect(result.costMicros).toBeNull();
    expect(result.currency).toBeNull();
    expect(result.unpricedReason).toContain("ai.reply");

    const stored = await rows();
    expect(stored[0]?.cost_micros).toBeNull();
    expect(stored[0]?.currency).toBeNull();
    expect(stored[0]?.price_version).toBe(ACTIVE_PRICE_VERSION);
  });

  it("does not throw for an unpriced kind", async () => {
    /*
     * Stated separately because it is the actual requirement: the usage record
     * must never be the thing that fails a provider call that already
     * succeeded. The work happened and the customer is owed it.
     */
    await expect(
      withCompany(company.id, (db, companyId) =>
        recordUsage(db, companyId, {
          kind: "nothing.prices.this" as never,
          dedupeKey: "unpriced-2",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("records once when the same work is emitted twice", async () => {
    /*
     * The retry. DEFAULT_JOB_OPTIONS sets attempts: 5, so a job that records
     * usage and then fails runs this again with the same derived key.
     */
    const dedupeKey = usageDedupeKey("integration.verify", "job7", "int3");

    const first = await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, { kind: "integration.verify", dedupeKey }),
    );
    const second = await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, { kind: "integration.verify", dedupeKey }),
    );

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("survives five attempts, which is what the queue actually does", async () => {
    const dedupeKey = usageDedupeKey("integration.verify", "job8", "int4");

    for (let attempt = 0; attempt < 5; attempt++) {
      await withCompany(company.id, (db, companyId) =>
        recordUsage(db, companyId, { kind: "integration.verify", dedupeKey }),
      );
    }

    expect(await rows()).toHaveLength(1);
  });

  it("lets two companies use the same dedupe key", async () => {
    /*
     * The constraint is scoped to the company. A key derived from a job id
     * would otherwise let one tenant's retry suppress another tenant's charge.
     */
    const other = await seedCompany("usage_other");
    const dedupeKey = "shared-key";

    await withCompany(company.id, (db, companyId) =>
      recordUsage(db, companyId, { kind: "integration.verify", dedupeKey }),
    );
    const second = await withCompany(other.id, (db, companyId) =>
      recordUsage(db, companyId, { kind: "integration.verify", dedupeKey }),
    );

    expect(second.recorded).toBe(true);
  });

  it("leaves no usage row when the surrounding transaction rolls back", async () => {
    /*
     * Why this takes a db rather than opening its own scope: a charge must not
     * outlive the thing it describes.
     */
    await expect(
      withCompany(company.id, async (db, companyId) => {
        await recordUsage(db, companyId, {
          kind: "integration.verify",
          dedupeKey: "rolled-back",
        });
        throw new Error("the work failed after usage was recorded");
      }),
    ).rejects.toThrow(/the work failed/);

    expect(await rows()).toHaveLength(0);
  });
});

describe("totalling", () => {
  it("ignores unpriced rows rather than counting them as free", async () => {
    await withCompany(company.id, async (db, companyId) => {
      await recordUsage(db, companyId, {
        kind: "integration.verify",
        dedupeKey: "priced",
      });
      await recordUsage(db, companyId, {
        kind: "ai.reply" as never,
        dedupeKey: "unpriced",
      });
    });

    const [totals] = await withCompany(
      company.id,
      (db) => db.$queryRaw<Array<{ total: bigint | null; unpriced: bigint }>>`
        SELECT SUM(cost_micros) AS total,
               count(*) FILTER (WHERE cost_micros IS NULL) AS unpriced
          FROM usage_events
      `,
    );

    /*
     * Two rows, one of them unpriced. The total is honest about what it knows
     * and the count is what stops the gap being absorbed into it — which is
     * the whole reason the column is nullable.
     */
    expect(Number(totals?.total ?? 0)).toBe(0);
    expect(Number(totals?.unpriced ?? 0)).toBe(1);
  });
});
