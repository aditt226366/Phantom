import { beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The four guarantees the Meta Ads tables make in the database rather than in
 * code, because each one costs real money to get wrong.
 *
 * None of these is visible to `prisma migrate diff`: schema.prisma can express
 * the DEFAULT but not either CHECK, and a check that vanished from a migration
 * would be reported by nothing. Two of them are in OUT_OF_BAND_DDL for that
 * reason; this file is the half that proves they still do something.
 */

let company: SeededCompany;
let adAccountId: string;

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("ads");

  adAccountId = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "META_ADS", label: "ads" },
      select: { id: true },
    });

    const account = await db.metaAdAccount.create({
      data: {
        companyId,
        integrationId: integration.id,
        metaAdAccountId: "act_1234567890",
        name: "Monsoon account",
        currency: "INR",
      },
      select: { id: true },
    });

    return account.id;
  });
});

describe("a campaign is created paused", () => {
  it("lands PAUSED through the ORM when nothing says otherwise", async () => {
    /*
     * The safety property of the phase, at the layer the application uses.
     *
     * What being wrong costs is not a wrong badge. It is a campaign spending a
     * tenant's daily budget from the moment a form posts, with no undo,
     * against a number somebody typed while still thinking about it.
     *
     * -----------------------------------------------------------------------
     * This asserts Prisma's default, NOT the column's, and they are different
     * -----------------------------------------------------------------------
     *
     * Measured, because the first version of this comment claimed the opposite.
     * With the database default deliberately altered to ARCHIVED, this test
     * still passed - and a raw INSERT omitting the column in the same database
     * landed ARCHIVED. Prisma Client sends the value from `@default()` in the
     * GENERATED client rather than leaving the column out, so the database
     * default is never consulted on this path and could be anything at all.
     *
     * That makes the pair below the point rather than a nicety: this test
     * covers every write the app makes, and the next one covers every write it
     * does not - a migration, a backfill, a psql session. Neither is sufficient
     * alone, and only one of them was here to begin with.
     */
    const created = await withCompany(company.id, (db, companyId) =>
      db.metaCampaign.create({
        data: {
          companyId,
          adAccountId,
          metaCampaignId: "mc-1",
          name: "Monsoon sale",
          objective: "OUTCOME_LEADS",
          currency: "INR",
        },
        select: { status: true, publishedAt: true },
      }),
    );

    expect(created.status).toBe("PAUSED");
    expect(created.publishedAt).toBeNull();
  });

  it("lands PAUSED through a write that never sees Prisma", async () => {
    /*
     * The column's own default, reached by naming every other column and
     * leaving `status` out - which is the one way to ask the database what it
     * would do on its own.
     *
     * $executeRawUnsafe rather than the model, because a model call is exactly
     * what cannot answer this question: it fills the value in before the
     * statement is built. The parameters are bound, so "Unsafe" here refers to
     * the un-templated SQL string and not to interpolated input.
     *
     * Break-once: with the column default altered to ARCHIVED this fails, and
     * the ORM test above does not. That divergence is the whole reason both
     * exist. The DDL was restored with `npm run db:nuke -- test`, never by
     * hand - a hand-restored constraint has been silently wrong here before.
     */
    await withCompany(company.id, async (db, companyId) => {
      await db.$executeRawUnsafe(
        `INSERT INTO meta_campaigns
           (id, company_id, ad_account_id, meta_campaign_id, name, objective,
            currency, updated_at)
         VALUES ($1, $2, $3, 'mc-raw', 'Written past the ORM', 'OUTCOME_LEADS',
                 'INR', now())`,
        "raw-campaign",
        companyId,
        adAccountId,
      );
    });

    const rows = await withCompany(company.id, (db) =>
      db.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM meta_campaigns WHERE id = 'raw-campaign'`,
    );

    expect(rows[0]?.status).toBe("PAUSED");
  });

  it("refuses to go ACTIVE without recording when it was published", async () => {
    /*
     * The CHECK, from the side that must fail. "Who started this spending and
     * when" is the first question asked about an ad bill, and a live campaign
     * with a null published_at has no answer to it - for exactly the campaigns
     * where somebody is asking.
     */
    await expect(
      withCompany(company.id, (db, companyId) =>
        db.metaCampaign.create({
          data: {
            companyId,
            adAccountId,
            metaCampaignId: "mc-2",
            name: "Straight to live",
            objective: "OUTCOME_LEADS",
            currency: "INR",
            status: "ACTIVE",
          },
        }),
      ),
    ).rejects.toThrow(/meta_campaigns_active_has_been_published/);
  });

  it("allows ACTIVE once it carries its instant", async () => {
    /*
     * The other side of the constraint. A single-sided assertion passes for a
     * CHECK that refuses everything, which is a different bug with the same
     * green test.
     */
    const published = new Date("2026-09-02T11:30:00.000Z");

    const created = await withCompany(company.id, (db, companyId) =>
      db.metaCampaign.create({
        data: {
          companyId,
          adAccountId,
          metaCampaignId: "mc-3",
          name: "Deliberately live",
          objective: "OUTCOME_ENGAGEMENT",
          currency: "INR",
          status: "ACTIVE",
          publishedAt: published,
        },
        select: { status: true, publishedAt: true },
      }),
    );

    expect(created.status).toBe("ACTIVE");
    expect(created.publishedAt?.toISOString()).toBe(published.toISOString());
  });
});

describe("a day's spend", () => {
  async function recordDay(
    metaCampaignId: string,
    spendMicros: bigint,
    impressions = 1000n,
  ) {
    return withCompany(company.id, (db, companyId) =>
      db.metaAdInsight.upsert({
        where: {
          companyId_adAccountId_metaCampaignId_date: {
            companyId,
            adAccountId,
            metaCampaignId,
            date: new Date("2026-09-01T00:00:00.000Z"),
          },
        },
        create: {
          companyId,
          adAccountId,
          metaCampaignId,
          date: new Date("2026-09-01T00:00:00.000Z"),
          impressions,
          clicks: 40n,
          spendMicros,
          currency: "INR",
        },
        update: { impressions, spendMicros },
        select: { spendMicros: true, impressions: true },
      }),
    );
  }

  it("is restated in place rather than added a second time", async () => {
    /*
     * What makes the sync idempotent, and the failure it prevents is
     * arithmetic rather than an error. Meta restates recent days as attribution
     * windows close, so a nightly sync re-reads the same 28 days every night.
     * Without the unique index that is 28 rows for one day and a month's spend
     * reported at 28 times the truth - a number that is merely wrong, on a page
     * where every other number is right.
     */
    await recordDay("mc-1", 100_000_000n);
    await recordDay("mc-1", 143_500_000n, 1600n);

    const rows = await withCompany(company.id, (db, companyId) =>
      db.metaAdInsight.findMany({
        where: { companyId },
        select: { spendMicros: true, impressions: true },
        orderBy: { id: "asc" },
      }),
    );

    expect(rows).toEqual([{ spendMicros: 143_500_000n, impressions: 1600n }]);
  });

  it("keeps two campaigns on the same day apart", async () => {
    await recordDay("mc-1", 100_000_000n);
    await recordDay("mc-2", 250_000_000n);

    const total = await withCompany(company.id, (db, companyId) =>
      db.metaAdInsight.count({ where: { companyId } }),
    );

    expect(total).toBe(2);
  });

  it("refuses a restatement that would subtract from the month", async () => {
    /*
     * Meta's API has returned negative figures during an outage. A negative
     * day would reduce a month's spend and make a cost-per-lead figure read
     * BETTER than the truth, which is the direction nobody checks.
     */
    await expect(
      withCompany(company.id, (db, companyId) =>
        db.metaAdInsight.create({
          data: {
            companyId,
            adAccountId,
            metaCampaignId: "mc-9",
            date: new Date("2026-09-03T00:00:00.000Z"),
            spendMicros: -1n,
            currency: "INR",
          },
        }),
      ),
    ).rejects.toThrow(/meta_ad_insights_counts_are_not_negative/);
  });

  it("survives a spend larger than a JSON number can carry", async () => {
    /*
     * 2^53 micros is about 9 billion units of currency, which a large
     * advertiser reaches inside a year. The column is BIGINT and the client
     * reads it as a bigint; the moment either becomes a double the last digits
     * go silently, which is the worst possible way to discover a column type.
     */
    const huge = 9_007_199_254_740_993n; // 2^53 + 1, unrepresentable as a double

    const written = await withCompany(company.id, (db, companyId) =>
      db.metaAdInsight.create({
        data: {
          companyId,
          adAccountId,
          metaCampaignId: "mc-big",
          date: new Date("2026-09-04T00:00:00.000Z"),
          spendMicros: huge,
          currency: "INR",
        },
        select: { spendMicros: true },
      }),
    );

    expect(written.spendMicros).toBe(huge);
    expect(typeof written.spendMicros).toBe("bigint");

    /* And why it has to stay one, demonstrated rather than asserted about.
       These are two different amounts of money and one double: anything that
       routes this column through a JSON number - an API response, a rollup, a
       chart's data prop - makes them the same figure with nothing to report. */
    expect(Number(huge)).toBe(Number(huge - 1n));
  });
});

describe("where a contact came from", () => {
  it("is null rather than INBOUND when nothing recorded it", async () => {
    /*
     * The column has no default, deliberately. Every contact predating this
     * phase would otherwise read as having arrived organically - a claim about
     * the tenant's own business that nothing ever checked.
     */
    const contact = await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: { companyId, waId: "919000000001" },
        select: { source: true },
      }),
    );

    expect(contact.source).toBeNull();
  });

  it("records a click-to-WhatsApp arrival as itself", async () => {
    const contact = await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: {
          companyId,
          waId: "919000000002",
          source: "ADS_CLICK_TO_WHATSAPP",
        },
        select: { source: true },
      }),
    );

    expect(contact.source).toBe("ADS_CLICK_TO_WHATSAPP");
  });
});
