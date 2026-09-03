import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading one ad account's spend.
 *
 * The database is mocked, as it is in every worker test here, and the split is
 * deliberate rather than a convenience. This file asserts the DECISIONS the
 * handler makes - which window it asks Meta for, which currency it writes,
 * which instant it stamps, what it does when Meta refuses. Whether re-writing
 * a day twice produces one row is a property of the unique index, and is
 * asserted against a real database in packages/db/tests/meta-ads-schema.test.ts
 * where the index actually exists.
 *
 * Testing the second thing here would prove only that a mock does what the
 * mock was told to.
 */

const recordDailySpend = vi.fn(
  async (_db: unknown, _companyId: string, _input: unknown) => undefined,
);
const recordUsage = vi.fn(
  async (_db: unknown, _companyId: string, _input: unknown) => ({ recorded: true }),
);
const markInsightsSynced = vi.fn(
  async (
    _db: unknown,
    _companyId: string,
    _adAccountId: string,
    _through: Date,
    _now: Date,
  ) => undefined,
);

let account: unknown = null;
let sealed: unknown = null;

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (
    companyId: string,
    fn: (db: unknown, id: string) => Promise<unknown>,
  ) => fn({}, companyId),
  findAdAccount: async () => account,
  metaAdsCredentials: async () => sealed,
  recordDailySpend,
  recordUsage,
  markInsightsSynced,
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

/*
 * decrypt is stubbed rather than given real key material. What this file is
 * about is the shape of the read, and a real seal/open round-trip here would
 * be testing the vault - which has its own suite and its own reasons.
 */
vi.mock("@whatsapp-os/core", async () => {
  const actual = await vi.importActual<typeof import("@whatsapp-os/core")>(
    "@whatsapp-os/core",
  );
  return { ...actual, decrypt: () => "EAAtesttoken" };
});

const { handleMetaInsightsSync } = await import("../src/jobs/meta-insights-sync.ts");

const NOW = new Date("2026-09-10T06:00:00.000Z");

const DAY = {
  campaign_id: "23842",
  campaign_name: "Monsoon sale",
  date_start: "2026-09-01",
  impressions: "4200",
  clicks: "130",
  spend: "812.34",
};

function stubFetch(rows: unknown[], status = 200, body?: unknown) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body ?? { data: rows }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  recordDailySpend.mockClear();
  recordUsage.mockClear();
  markInsightsSynced.mockClear();

  account = {
    id: "acct-row-1",
    metaAdAccountId: "act_555",
    currency: "INR",
  };
  sealed = {
    integrationId: "int-1",
    secrets: [{ key: "META_ADS_ACCESS_TOKEN", ciphertext: "sealed" }],
  };
});

const JOB = { companyId: "co-1", adAccountId: "acct-row-1", lookbackDays: 28 };

describe("reading a window of spend", () => {
  it("stores the day Meta named, in the account's currency", async () => {
    stubFetch([DAY]);

    const result = await handleMetaInsightsSync(JOB, NOW);

    expect(result.days).toBe(1);
    expect(result.spendMicros.get("INR")).toBe(812_340_000n);

    expect(recordDailySpend).toHaveBeenCalledTimes(1);
    expect(recordDailySpend.mock.calls[0]?.[2]).toMatchObject({
      adAccountId: "acct-row-1",
      metaCampaignId: "23842",
      campaignName: "Monsoon sale",
      impressions: 4200n,
      clicks: 130n,
      spendMicros: 812_340_000n,
      currency: "INR",
    });

    /* Meta reports a DAY. Stored as one, at UTC midnight, so it round-trips as
       the day they named rather than as an instant in somebody's zone. */
    const stored = recordDailySpend.mock.calls[0]?.[2] as { date: Date };
    expect(stored.date.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("asks for a window ending today, not for everything since a cursor", async () => {
    /*
     * The design of the whole job. Meta restates a day for most of a week as
     * attribution windows close, so a forward-only cursor would keep the first
     * figure it ever saw for every day - and the first figure is the one most
     * likely to be revised. The month would settle on a number that was never
     * right and would never be corrected.
     */
    const urls = stubFetch([]);

    await handleMetaInsightsSync({ ...JOB, lookbackDays: 7 }, NOW);

    const decoded = decodeURIComponent(urls[0] ?? "");
    expect(decoded).toContain('"since":"2026-09-03"');
    expect(decoded).toContain('"until":"2026-09-10"');
    expect(decoded).toContain("time_increment=1");
  });

  it("dedupes usage on the account, campaign and day", async () => {
    /*
     * The same key the insight row is written under, so the two can never
     * disagree about a day. Without it a nightly 28-day window would write 28
     * usage rows for every campaign-day inside a month.
     */
    stubFetch([DAY]);

    await handleMetaInsightsSync(JOB, NOW);

    expect(recordUsage.mock.calls[0]?.[2]).toMatchObject({
      kind: "meta.ad.spend",
      dedupeKey: "meta.ad.spend:acct-row-1:23842:2026-09-01",
    });
  });

  it("stamps the usage row with Meta's day, not the run's", async () => {
    /* A re-sync weeks later must land the event on the day it describes, or a
       quarter's spend moves to whenever somebody happened to run it. */
    stubFetch([DAY]);

    await handleMetaInsightsSync(JOB, NOW);

    const recorded = recordUsage.mock.calls[0]?.[2] as { occurredAt: Date };
    expect(recorded.occurredAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("denominates the row from the account, not the response", async () => {
    /*
     * A spend figure labelled with the wrong currency is invisible: the number
     * is plausible, only the label is wrong, and there is no exchange rate
     * anywhere in this system to notice with.
     *
     * The guarantee is STRUCTURAL rather than a choice this job makes, and
     * that is worth recording because it was learned by trying to break it.
     * Rewriting the job to prefer a currency off the response changed nothing
     * and no test failed - because DailyCampaignSpend has no currency field:
     * campaignInsights never parses one out of the row, so there is nothing
     * here to prefer. The response below carries a USD label precisely to show
     * it cannot reach the column.
     *
     * What this assertion catches is the live half - the account value being
     * used at all - and forcing a literal in its place does fail it.
     */
    stubFetch([{ ...DAY, currency: "USD" }]);

    await handleMetaInsightsSync(JOB, NOW);

    expect(recordDailySpend.mock.calls[0]?.[2]).toMatchObject({ currency: "INR" });
  });

  it("marks how far it read, after it has read", async () => {
    stubFetch([DAY]);

    await handleMetaInsightsSync(JOB, NOW);

    expect(markInsightsSynced).toHaveBeenCalledTimes(1);
    const through = markInsightsSynced.mock.calls[0]?.[3] as Date;
    expect(through.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });
});

describe("when it cannot read", () => {
  it("throws on a Graph failure and leaves the marker alone", async () => {
    /*
     * A silent success would advance the marker over a window nothing was read
     * for. Nothing branches on that marker today - the job always re-reads a
     * window - but it is a REPORT of a fact shown to a tenant, and reporting a
     * sync that did not happen is how the next reader is misled.
     */
    stubFetch([], 400, { error: { message: "Session expired", code: 190 } });

    await expect(handleMetaInsightsSync(JOB, NOW)).rejects.toThrow(/auth/);

    expect(markInsightsSynced).not.toHaveBeenCalled();
    expect(recordDailySpend).not.toHaveBeenCalled();
  });

  it("does nothing quietly when the account has been removed", async () => {
    /*
     * The removal action unregisters the schedule, and this is the tick that
     * races it. Throwing would retry a job that can never succeed, and would
     * put a permanent failure in the queue for a row somebody deleted on
     * purpose.
     */
    account = null;

    const result = await handleMetaInsightsSync(JOB, NOW);

    expect(result.skipped).toBe("account_removed");
    expect(result.days).toBe(0);
    expect(markInsightsSynced).not.toHaveBeenCalled();
  });

  it("does nothing quietly when the credentials are gone", async () => {
    sealed = null;

    const result = await handleMetaInsightsSync(JOB, NOW);

    expect(result.skipped).toBe("no_credentials");
    expect(recordDailySpend).not.toHaveBeenCalled();
  });
});
