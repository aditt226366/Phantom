import { describe, expect, it, vi } from "vitest";
import {
  campaignInsights,
  createPausedCampaign,
  listAdAccounts,
  listPages,
  minorUnitsFromMicros,
  pageWhatsAppLink,
  spendToMicros,
} from "../src/providers/meta-ads.ts";

/**
 * The Marketing API surface, against a fetch that never leaves the process.
 *
 * Every test here is about one of three things: money that must not pass
 * through a float, a campaign that must not be created running, and a response
 * shape Meta actually returns which the obvious decoder would get wrong.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that records what it was asked and answers with a fixture. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body, status);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("spend, which must never become a float", () => {
  it("reads Meta's decimal string exactly", () => {
    expect(spendToMicros("1234.56")).toBe(1_234_560_000n);
    expect(spendToMicros("0.01")).toBe(10_000n);
    expect(spendToMicros("7")).toBe(7_000_000n);
  });

  it("handles a currency with three decimal places", () => {
    /* KWD. A two-place assumption would drop the last digit of every figure
       in Kuwait, which is a 10x error that looks like a small one. */
    expect(spendToMicros("12.345")).toBe(12_345_000n);
  });

  it("keeps a figure a double would round", () => {
    /*
     * The reason this is string arithmetic. 90071992547409.93 is above 2^53
     * once expressed in micros, and Number() cannot hold it - the assertion
     * below shows the parse being exact and the float route being wrong for
     * the same input.
     */
    const exact = spendToMicros("90071992547409.93");

    expect(exact).toBe(90_071_992_547_409_930_000n);
    expect(BigInt(Math.round(Number("90071992547409.93") * 1_000_000))).not.toBe(exact);
  });

  it("returns null for anything it cannot parse, rather than zero", () => {
    /*
     * Null and 0 are different claims: "we could not read this" against "this
     * campaign spent nothing". A sync that turned the first into the second
     * would under-report a month's cost with nothing to say so.
     */
    expect(spendToMicros("")).toBeNull();
    expect(spendToMicros("n/a")).toBeNull();
    expect(spendToMicros("1.2.3")).toBeNull();
  });
});

describe("a budget Meta can express", () => {
  it("converts whole minor units", () => {
    expect(minorUnitsFromMicros(500_000_000n)).toBe("50000");
  });

  it("refuses a budget finer than the currency", () => {
    /*
     * Exact or nothing. Rounding down spends less than the tenant asked for;
     * rounding up spends more than they authorised. Both are decisions this
     * function has no standing to make on their behalf.
     */
    expect(() => minorUnitsFromMicros(1_234_567n)).toThrow(/whole minor unit/);
  });
});

describe("listing what the token can reach", () => {
  it("returns the accounts Meta named", async () => {
    const { impl, calls } = stubFetch({
      data: [
        {
          id: "act_111",
          name: "Monsoon",
          currency: "INR",
          timezone_name: "Asia/Kolkata",
          account_status: 1,
        },
      ],
    });

    const result = await listAdAccounts("tok", impl);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual([
      {
        id: "act_111",
        name: "Monsoon",
        currency: "INR",
        timezoneName: "Asia/Kolkata",
        accountStatus: 1,
      },
    ]);

    /* The path must survive encoding. encodeURIComponent over the whole thing
       turns me/adaccounts into me%2Fadaccounts and Meta 400s on a node that
       does not exist - an error a long way from its cause. */
    expect(calls[0]?.url).toContain("/me/adaccounts?");
    expect(calls[0]?.url).not.toContain("%2F");
  });

  it("skips an account with no currency rather than inventing one", async () => {
    /*
     * Currency is what stops spend being summed across accounts. An account
     * that cannot state one is not selectable, and defaulting it would put a
     * figure on the dashboard denominated in a guess.
     */
    const { impl } = stubFetch({
      data: [{ id: "act_1", name: "Fine", currency: "INR" }, { id: "act_2", name: "Odd" }],
    });

    const result = await listAdAccounts("tok", impl);

    expect(result.ok && result.data.map((a) => a.id)).toEqual(["act_1"]);
  });

  it("carries a Graph auth failure through unchanged", async () => {
    /*
     * Code 190 with an HTTP 400, which is the shape a revoked token actually
     * arrives in. Status alone classifies it `config`; the decoder in meta.ts
     * knows the code, and this asserts nothing here re-classifies it.
     */
    const { impl } = stubFetch(
      { error: { message: "Session has expired", code: 190, fbtrace_id: "Axyz" } },
      400,
    );

    const result = await listAdAccounts("tok", impl);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("auth");
    expect(!result.ok && result.details?.["fbtrace_id"]).toBe("Axyz");
  });
});

describe("the Page a click-to-WhatsApp ad posts from", () => {
  it("reports the linked number", async () => {
    const { impl } = stubFetch({
      whatsapp_number: "+919876543210",
      connected_whatsapp_business_account: { id: "waba-1" },
    });

    const result = await pageWhatsAppLink("page-1", "tok", impl);

    expect(result.ok && result.data).toEqual({
      phoneNumber: "+919876543210",
      wabaId: "waba-1",
    });
  });

  it("treats a Page with no WhatsApp connection as an answer, not a failure", async () => {
    /*
     * A legitimate state, and the one the selection screen most needs to
     * render clearly: an ad from this Page will never reach an inbox we can
     * see. Making it an error would put a red banner on a correct
     * configuration decision the tenant has not made yet.
     */
    const { impl } = stubFetch({});

    const result = await pageWhatsAppLink("page-1", "tok", impl);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toEqual({ phoneNumber: null, wabaId: null });
  });

  it("lists pages", async () => {
    const { impl } = stubFetch({ data: [{ id: "p1", name: "Shop" }, { id: "p2" }] });

    const result = await listPages("tok", impl);

    expect(result.ok && result.data).toEqual([
      { id: "p1", name: "Shop" },
      /* No name: the id is a worse label than a name and a better one than a
         blank row in a select. */
      { id: "p2", name: "p2" },
    ]);
  });
});

describe("creating a campaign", () => {
  it("always asks Meta for PAUSED", async () => {
    /*
     * The safety property, at the boundary. There is no input field for
     * status and no branch that sets it - a caller cannot ask for a running
     * campaign even by mistake, which is the point of the input type having
     * no such field.
     */
    const { impl, calls } = stubFetch({ id: "23842" });

    const result = await createPausedCampaign(
      {
        adAccountId: "act_111",
        name: "Monsoon sale",
        objective: "OUTCOME_LEADS",
        dailyBudgetMicros: 500_000_000n,
      },
      "tok",
      impl,
    );

    expect(result.ok && result.data.id).toBe("23842");

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.status).toBe("PAUSED");
    expect(body.daily_budget).toBe("50000");
    /* Required by Meta on every create; omitting it is a 400 that reads like
       a permissions problem. */
    expect(body.special_ad_categories).toEqual([]);
  });

  it("refuses a 200 that carries no id", async () => {
    /*
     * Config rather than transient, so it demotes and nothing retries.
     * Retrying an ambiguous create is how a tenant ends up paying for two
     * campaigns.
     */
    const { impl } = stubFetch({});

    const result = await createPausedCampaign(
      { adAccountId: "act_111", name: "n", objective: "OUTCOME_LEADS" },
      "tok",
      impl,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("config");
  });

  it("sends no budget when none was given", async () => {
    const { impl, calls } = stubFetch({ id: "1" });

    await createPausedCampaign(
      { adAccountId: "act_111", name: "n", objective: "OUTCOME_TRAFFIC" },
      "tok",
      impl,
    );

    expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty("daily_budget");
  });
});

describe("insights", () => {
  it("asks for a day at a time, which is what makes the sync idempotent", async () => {
    const { impl, calls } = stubFetch({
      data: [
        {
          campaign_id: "23842",
          campaign_name: "Monsoon sale",
          date_start: "2026-09-01",
          impressions: "4200",
          clicks: "130",
          spend: "812.34",
        },
      ],
    });

    const result = await campaignInsights("act_111", "2026-09-01", "2026-09-07", "tok", impl);

    expect(result.ok && result.data).toEqual([
      {
        metaCampaignId: "23842",
        campaignName: "Monsoon sale",
        date: "2026-09-01",
        impressions: 4200n,
        clicks: 130n,
        spendMicros: 812_340_000n,
      },
    ]);

    /* Without time_increment=1 a row is the whole range rather than a day, and
       there is no stable key to update on a re-read. */
    expect(calls[0]?.url).toContain("time_increment=1");
    expect(calls[0]?.url).toContain("level=campaign");
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain(
      '{"since":"2026-09-01","until":"2026-09-07"}',
    );
  });

  it("drops a row with no campaign or no day", async () => {
    /* There is no key to write it under, so storing it would put a figure
       where nothing can ever update or supersede it. */
    const { impl } = stubFetch({
      data: [
        { campaign_id: "1", date_start: "2026-09-01", spend: "1.00" },
        { campaign_id: "2", spend: "5.00" },
        { date_start: "2026-09-02", spend: "9.00" },
      ],
    });

    const result = await campaignInsights("act_111", "a", "b", "tok", impl);

    expect(result.ok && result.data.map((d) => d.metaCampaignId)).toEqual(["1"]);
  });

  it("reads a day with no delivery as zero", async () => {
    const { impl } = stubFetch({
      data: [{ campaign_id: "1", date_start: "2026-09-01" }],
    });

    const result = await campaignInsights("act_111", "a", "b", "tok", impl);

    expect(result.ok && result.data[0]).toMatchObject({
      impressions: 0n,
      clicks: 0n,
      spendMicros: 0n,
    });
  });
});
