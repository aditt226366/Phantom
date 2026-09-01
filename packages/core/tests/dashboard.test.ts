import { describe, expect, it } from "vitest";
import {
  CLOSING_WINDOW_HORIZON_MINUTES,
  DASHBOARD_ROLLUP_STALE_AFTER_SECONDS,
  countedDayIsCurrent,
  currencySpend,
  dashboardWindows,
  rate,
  rollupFreshness,
  summariseFailures,
} from "../src/dashboard.ts";

/**
 * The four things on this page that fail silently.
 *
 * Everything else about a dashboard announces itself when it breaks - a card
 * throws, a number is obviously absurd, a bar runs off the side. These four do
 * not. Each produces a page that renders perfectly and states something untrue,
 * which is why they are the four the brief singles out for break-once and why
 * they are asserted here as exact values rather than as tolerances.
 */

describe("the windows the queries bind", () => {
  /*
   * A literal instant, and an awkward one on purpose: 18:45 UTC is 00:15 the
   * NEXT day in IST. A boundary computed from the server's own date - or from
   * a hardcoded +05:30 added in the wrong direction - lands a day out here and
   * nowhere else, which is why the fixture is this instant and not noon.
   */
  const lateEvening = new Date("2026-09-01T18:45:00.000Z");

  it("puts the day boundary at IST midnight, not UTC midnight", () => {
    const windows = dashboardWindows(lateEvening);

    /* 2 September 00:00 IST is 1 September 18:30 UTC - fifteen minutes before
       the reading, so "today" has just started and is nearly empty. */
    expect(windows.dayStart.toISOString()).toBe("2026-09-01T18:30:00.000Z");
    expect(windows.timezoneLabel).toBe("IST");
  });

  it("puts the month boundary at IST midnight on the first", () => {
    const windows = dashboardWindows(lateEvening);

    /* 1 September 00:00 IST is 31 August 18:30 UTC. A UTC-derived month start
       would say 2026-09-01T00:00Z and quietly include 31 August's evening. */
    expect(windows.monthStart.toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });

  it("puts the closing horizon exactly an hour out", () => {
    const windows = dashboardWindows(lateEvening);

    expect(windows.closingHorizon.getTime() - lateEvening.getTime()).toBe(
      CLOSING_WINDOW_HORIZON_MINUTES * 60_000,
    );
  });
});

describe("freshness", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("distinguishes never-computed from computed-and-empty", () => {
    /*
     * The distinction the whole rollup depends on. A company whose scheduler
     * never registered has no row, and showing it zeroes would be a page
     * confidently reporting that nothing has ever been sent.
     */
    expect(rollupFreshness(null, now)).toEqual({ state: "never" });
    expect(rollupFreshness(undefined, now)).toEqual({ state: "never" });
  });

  it("calls an ordinary lateness fresh", () => {
    const computedAt = new Date(now.getTime() - 90_000);
    const freshness = rollupFreshness(computedAt, now);

    expect(freshness).toEqual({ state: "fresh", computedAt, ageSeconds: 90 });
  });

  it("turns stale one second past the threshold, and not before", () => {
    /* Both sides of the boundary, because an off-by-one here is a notice that
       either never appears or never goes away. */
    const atThreshold = new Date(
      now.getTime() - DASHBOARD_ROLLUP_STALE_AFTER_SECONDS * 1000,
    );
    const pastThreshold = new Date(
      now.getTime() - (DASHBOARD_ROLLUP_STALE_AFTER_SECONDS + 1) * 1000,
    );

    expect(rollupFreshness(atThreshold, now).state).toBe("fresh");
    expect(rollupFreshness(pastThreshold, now).state).toBe("stale");
  });

  it("clamps clock skew to zero rather than reporting a negative age", () => {
    const computedAt = new Date(now.getTime() + 2_000);

    expect(rollupFreshness(computedAt, now)).toMatchObject({
      state: "fresh",
      ageSeconds: 0,
    });
  });
});

describe("the day a rollup counted against", () => {
  /*
   * The fault a freshness check cannot see. At 00:04 IST a rollup computed at
   * 23:59 is five minutes old - perfectly fresh - and its "new today" is a
   * complete count of yesterday.
   */
  const justAfterMidnightIst = new Date("2026-09-01T18:34:00.000Z");
  const todayIst = new Date("2026-09-01T18:30:00.000Z");
  const yesterdayIst = new Date("2026-08-31T18:30:00.000Z");

  it("accepts the boundary of the day being had", () => {
    expect(countedDayIsCurrent(todayIst, justAfterMidnightIst)).toBe(true);
  });

  it("rejects yesterday's boundary even when the rollup is minutes old", () => {
    expect(countedDayIsCurrent(yesterdayIst, justAfterMidnightIst)).toBe(false);
    /* And the rollup really is fresh, which is the point of the pair. */
    expect(
      rollupFreshness(
        new Date(justAfterMidnightIst.getTime() - 300_000),
        justAfterMidnightIst,
      ).state,
    ).toBe("fresh");
  });

  it("rejects a missing boundary", () => {
    expect(countedDayIsCurrent(null, justAfterMidnightIst)).toBe(false);
  });
});

describe("failures, grouped the way a person can act on them", () => {
  it("separates Meta's four back-off codes from everything else", () => {
    const breakdown = summariseFailures({
      "131049": 4,
      "130472": 1,
      "131056": 2,
      "133016": 1,
      "131026": 3,
      "131047": 5,
    });

    expect(breakdown).toEqual({
      deliveryLimited: 8,
      undeliverable: 3,
      other: 5,
      total: 16,
    });
  });

  it("counts a policy refusal as other rather than dropping it", () => {
    /*
     * Our own refusals carry no Meta code and are stored under a sentinel key.
     * Dropping them would make the breakdown's total disagree with the failed
     * count beside it, which reads as an arithmetic bug in the page.
     */
    const breakdown = summariseFailures({ POLICY: 2, "131049": 1 });

    expect(breakdown.other).toBe(2);
    expect(breakdown.total).toBe(3);
  });

  it("is empty for an empty map, and totals nothing", () => {
    expect(summariseFailures({})).toEqual({
      deliveryLimited: 0,
      undeliverable: 0,
      other: 0,
      total: 0,
    });
  });
});

describe("money", () => {
  it("keeps currencies apart and never produces a total", () => {
    const spend = currencySpend({ USD: "50000000", INR: "4000000000" });

    /* Sorted by code, so the order does not move under the reader. */
    expect(spend).toEqual([
      { currency: "INR", micros: 4_000_000_000n },
      { currency: "USD", micros: 50_000_000n },
    ]);
  });

  it("survives a figure past what a JSON number can hold", () => {
    /*
     * The reason the map stores strings. 2^53 micros is about 9 billion units
     * of currency; a double rounds anything past it, and a spend total that
     * quietly loses its last digits is the worst possible way to find that out.
     */
    const beyondDouble = "9007199254740993";
    const [entry] = currencySpend({ INR: beyondDouble });

    expect(entry?.micros).toBe(9_007_199_254_740_993n);
    expect(entry?.micros.toString()).toBe(beyondDouble);
  });

  it("drops a currency that netted nothing rather than listing a zero", () => {
    expect(currencySpend({ INR: "0" })).toEqual([]);
  });
});

describe("rates", () => {
  it("is null with no denominator, which is not zero", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(0, 10)).toBe(0);
  });

  it("is a percentage", () => {
    expect(rate(3, 4)).toBe(75);
  });
});
