import { describe, expect, it } from "vitest";
import { formatMicros, parseDailyBudget } from "@/lib/meta-ads/budget";

/**
 * Reading a daily budget somebody typed.
 *
 * This is the one number in the section that spends money without anybody
 * pressing anything again, and every way a text field goes wrong here is
 * expensive in the same direction.
 */

describe("parsing a daily budget", () => {
  it("reads a plain amount", () => {
    expect(parseDailyBudget("2500", "INR")).toEqual({ ok: true, micros: 2_500_000_000n });
    expect(parseDailyBudget("2500.50", "INR")).toEqual({
      ok: true,
      micros: 2_500_500_000n,
    });
  });

  it("accepts the separators people actually type", () => {
    expect(parseDailyBudget("2,500", "INR")).toEqual({ ok: true, micros: 2_500_000_000n });
    expect(parseDailyBudget(" 2 500 ", "INR")).toEqual({
      ok: true,
      micros: 2_500_000_000n,
    });
  });

  it("refuses what parseFloat would silently accept", () => {
    /*
     * The reason this is a regex and not a coercion. parseFloat("1,000") is 1
     * and parseFloat("12abc") is 12 - both succeed, both are wrong by a lot,
     * and neither leaves anything to report. A budget that silently became a
     * thousandth of what somebody meant is the good direction of that error;
     * the other one exists too.
     */
    for (const bad of ["12abc", "1.2.3", "-500", "1e5", "₹2500", ""]) {
      const result = parseDailyBudget(bad, "INR");
      expect(result.ok, `${JSON.stringify(bad)} should be refused`).toBe(false);
    }
  });

  it("refuses a third decimal place", () => {
    /* A budget is expressed in the currency's minor unit. A third place is a
       number Meta cannot take, and minorUnitsFromMicros throws on it - a throw
       inside a server action is a 500 rather than a sentence. */
    expect(parseDailyBudget("100.005", "INR").ok).toBe(false);
  });

  it("refuses an amount too small to deliver", () => {
    expect(parseDailyBudget("0", "INR").ok).toBe(false);
    expect(parseDailyBudget("0.50", "INR").ok).toBe(false);
  });

  it("brackets the ceiling from both sides", () => {
    /*
     * The ceiling catches a misplaced decimal point, not a policy. Asserted
     * from both sides, because a single assertion above it passes for a
     * ceiling of any value - including one that refuses every real budget.
     */
    expect(parseDailyBudget("10000000", "INR").ok).toBe(true);
    expect(parseDailyBudget("10000001", "INR").ok).toBe(false);
    expect(parseDailyBudget("10000001", "INR")).toMatchObject({
      error: expect.stringContaining("decimal point"),
    });
  });

  it("names the currency in its refusals", () => {
    /* The tenant has two accounts in two currencies and this form is where
       they pick one. A message that did not say which would be read against
       whichever they had in mind. */
    expect(parseDailyBudget("abc", "USD")).toMatchObject({
      error: expect.stringContaining("USD"),
    });
  });
});

describe("rendering an amount back", () => {
  it("prints the account's own currency and never converts", () => {
    expect(formatMicros(2_500_000_000n, "INR")).toBe("2,500.00 INR");
    expect(formatMicros(2_500_000_000n, "USD")).toBe("2,500.00 USD");
  });

  it("keeps the minor unit", () => {
    expect(formatMicros(2_500_500_000n, "INR")).toBe("2,500.50 INR");
    expect(formatMicros(10_000n, "INR")).toBe("0.01 INR");
  });

  it("survives a figure a double would round", () => {
    /* The column is BIGINT for this reason. A formatter that took a number
       would lose the last digits of a large advertiser's yearly spend. */
    expect(formatMicros(9_007_199_254_740_993n, "INR")).toContain("9,007,199,254.74");
  });
});
