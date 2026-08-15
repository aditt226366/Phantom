import { PLATFORM_TIMEZONE, startOfPlatformDay } from "@whatsapp-os/core";
import { createCompany, newCompanyId, recordUsage, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { getPlatformOverview } from "@/lib/admin-db";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The overview, against a real database — including an empty one.
 */

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "usage_events", "integration_secrets", "integrations",
                      "users", "companies" RESTART IDENTITY CASCADE`,
    ),
  );
});

async function seedCompany(name: string, plan = "STARTER"): Promise<string> {
  const id = newCompanyId();
  await withCompany(id, (db, scoped) => createCompany(db, scoped, name));
  await superuser((client) =>
    client.query(`UPDATE companies SET plan = $2::plan WHERE id = $1`, [id, plan]),
  );
  return id;
}

describe("an empty installation", () => {
  it("reports zeroes rather than failing", async () => {
    /*
     * The state a fresh deployment is in, and the one that is easiest never to
     * open. Every figure here divides or aggregates over something that does
     * not exist yet.
     */
    const overview = await getPlatformOverview();

    expect(overview.totalCompanies).toBe(0);
    expect(overview.activeCompanies).toBe(0);
    expect(overview.deactivatedCompanies).toBe(0);
    expect(overview.totalUsers).toBe(0);
    expect(overview.apiCallsToday).toBe(0);
    expect(overview.spendThisMonth).toEqual([]);
    expect(overview.unpricedThisMonth).toBe(0);
    expect(overview.planDistribution).toEqual([]);
  });
});

describe("company counts", () => {
  it("splits active from deactivated", async () => {
    await seedCompany("Alpha");
    const beta = await seedCompany("Beta");

    await superuser((client) =>
      client.query(`UPDATE companies SET deactivated_at = now() WHERE id = $1`, [
        beta,
      ]),
    );

    const overview = await getPlatformOverview();

    expect(overview.totalCompanies).toBe(2);
    expect(overview.activeCompanies).toBe(1);
    expect(overview.deactivatedCompanies).toBe(1);
  });

  it("counts every plan that has companies on it", async () => {
    await seedCompany("Alpha", "STARTER");
    await seedCompany("Beta", "PRO");
    await seedCompany("Gamma", "PRO");

    const overview = await getPlatformOverview();

    expect(overview.planDistribution).toEqual([
      { plan: "PRO", count: 2 },
      { plan: "STARTER", count: 1 },
    ]);
  });
});

describe("API calls today", () => {
  it("counts from midnight in the platform's zone, not the server's", async () => {
    /*
     * Fixed instants, worked out by hand. The first version of this derived
     * its fixtures from startOfPlatformDay() and then asserted about them,
     * which stays self-consistent however wrong that function is — swapping
     * the whole implementation for a UTC boundary left it green.
     *
     * `now` is 11:00 IST on 15 August. The IST day therefore opened at
     * 18:30 UTC on the 14th; UTC midnight that day was 00:00 UTC on the 15th,
     * five and a half hours later. The two events straddle the IST boundary
     * and sit on the same side of the UTC one, so a UTC boundary counts zero
     * where this counts one.
     */
    const companyId = await seedCompany("Alpha");
    const now = new Date("2026-08-15T05:30:00.000Z");

    const justBefore = new Date("2026-08-14T18:00:00.000Z");
    const justAfter = new Date("2026-08-14T19:00:00.000Z");

    await withCompany(companyId, async (db, scoped) => {
      await recordUsage(db, scoped, {
        kind: "integration.verify",
        dedupeKey: "yesterday",
        occurredAt: justBefore,
      });
      await recordUsage(db, scoped, {
        kind: "integration.verify",
        dedupeKey: "today",
        occurredAt: justAfter,
      });
    });

    const overview = await getPlatformOverview(now);

    expect(overview.apiCallsToday).toBe(1);
  });

  it("counts across every company", async () => {
    const alpha = await seedCompany("Alpha");
    const beta = await seedCompany("Beta");

    for (const companyId of [alpha, beta]) {
      await withCompany(companyId, (db, scoped) =>
        recordUsage(db, scoped, {
          kind: "integration.verify",
          dedupeKey: `now-${companyId}`,
        }),
      );
    }

    expect((await getPlatformOverview()).apiCallsToday).toBe(2);
  });
});

describe("estimated spend", () => {
  it("aggregates per currency and never across them", async () => {
    /*
     * The reason the column carries a currency at all. One number combining
     * ₹ and $ has no unit, and would render exactly as convincingly as a real
     * total.
     */
    const companyId = await seedCompany("Alpha");

    await superuser((client) =>
      client.query(
        `INSERT INTO usage_events
           (id, company_id, kind, quantity, cost_micros, currency, price_version, dedupe_key, occurred_at)
         VALUES
           ('u1', $1, 'integration.verify', 1, 5000000, 'INR', 1, 'a', now()),
           ('u2', $1, 'integration.verify', 1, 2000000, 'INR', 1, 'b', now()),
           ('u3', $1, 'ai.reply',           1,  300000, 'USD', 1, 'c', now())`,
        [companyId],
      ),
    );

    const overview = await getPlatformOverview();

    expect(overview.spendThisMonth).toEqual([
      { currency: "INR", micros: 7_000_000n },
      { currency: "USD", micros: 300_000n },
    ]);
  });

  it("reports unpriced events instead of absorbing them", async () => {
    /*
     * A null cost is excluded from the SUM, so the total stays honest and
     * incomplete. This count is the only thing that says by how much — without
     * it the figure looks authoritative and is quietly short.
     */
    const companyId = await seedCompany("Alpha");

    await withCompany(companyId, async (db, scoped) => {
      await recordUsage(db, scoped, {
        kind: "integration.verify",
        dedupeKey: "priced",
      });
      await recordUsage(db, scoped, {
        kind: "nothing.prices.this" as never,
        dedupeKey: "unpriced",
      });
    });

    const overview = await getPlatformOverview();

    expect(overview.unpricedThisMonth).toBe(1);
    /* And the unpriced row contributed no currency bucket. */
    expect(overview.spendThisMonth.map((row) => row.currency)).toEqual(["INR"]);
  });
});

describe("the admin index", () => {
  it("is used for the platform-wide today count", async () => {
    /*
     * Confirmed with EXPLAIN rather than assumed. The composite index leads
     * with company_id and cannot serve a query with no company predicate, so
     * without a second index this is a sequential scan on the table that grows
     * fastest — and it runs on every load of this page.
     *
     * The planner prefers a seq scan on a tiny table whatever the indexes, so
     * the check disables that choice rather than seeding a million rows.
     */
    const companyId = await seedCompany("Alpha");
    await withCompany(companyId, (db, scoped) =>
      recordUsage(db, scoped, {
        kind: "integration.verify",
        dedupeKey: "explain",
      }),
    );

    const plan = await superuser(async (client) => {
      /*
       * SET, not SET LOCAL: outside a transaction SET LOCAL is silently a
       * no-op, so the first version of this measured the planner's ordinary
       * preference for a seq scan on a tiny table and told me nothing.
       */
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT count(*) FROM usage_events WHERE occurred_at >= $1`,
        [startOfPlatformDay()],
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("usage_events_occurred_at_idx");
  });
});

describe("the platform timezone", () => {
  it("is stated, so a figure cannot silently mean something else", () => {
    expect(PLATFORM_TIMEZONE).toBe("Asia/Kolkata");
  });
});
