import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The refresh job, and the two things about it that fail without a sound.
 *
 *   1. Bounds frozen at registration. A repeatable job's data is fixed when the
 *      scheduler is created, so a day boundary carried in the payload would pin
 *      "today" to the day the company signed up - permanently, with every card
 *      under that heading quietly describing it. The handler computing its own
 *      is the only thing standing between that and a dashboard nobody can tell
 *      is wrong.
 *   2. A stale computed_at. If the handler wrote a moment other than the one it
 *      actually ran at, the freshness line on the page would be a claim about
 *      nothing - and the page's whole answer to staleness is to print the age.
 *
 * Both are asserted against the arguments the handler passes down, because
 * neither has any other observable effect.
 */

/*
 * Typed to the real signature. vi.fn with a zero-argument implementation infers
 * its call tuple as [], so reading an argument off `mock.calls` runs perfectly
 * and fails to typecheck - which the conventions record and which this file
 * would hit on its first assertion.
 */
type Bounds = { computedAt: Date; dayStart: Date; monthStart: Date };

const refreshDashboardRollup =
  vi.fn<(db: unknown, bounds: Bounds) => Promise<void>>();

const withCompany =
  vi.fn<
    (companyId: string, callback: (db: unknown) => Promise<void>) => Promise<void>
  >();

vi.mock("@whatsapp-os/db", () => ({
  refreshDashboardRollup: (db: unknown, bounds: Bounds) =>
    refreshDashboardRollup(db, bounds),
  withCompany: (companyId: string, callback: (db: unknown) => Promise<void>) =>
    withCompany(companyId, callback),
}));

const { handleDashboardRollup } = await import(
  "../src/jobs/dashboard-rollup.ts"
);

beforeEach(() => {
  vi.useRealTimers();
  refreshDashboardRollup.mockReset();
  refreshDashboardRollup.mockResolvedValue(undefined);
  withCompany.mockReset();
  /* Run the callback, so the bounds actually reach the refresh. */
  withCompany.mockImplementation(async (_companyId, callback) => {
    await callback({});
  });
});

/** The bounds the handler passed to the refresh, on its only call. */
function boundsPassed(): Bounds {
  expect(refreshDashboardRollup).toHaveBeenCalledTimes(1);
  const call = refreshDashboardRollup.mock.calls[0];
  expect(call, "the refresh was never called").toBeDefined();
  return call![1];
}

describe("the scope it opens", () => {
  it("opens withCompany on the id in the payload and nothing else", async () => {
    await handleDashboardRollup({ companyId: "c_alpha" });

    expect(withCompany).toHaveBeenCalledTimes(1);
    expect(withCompany.mock.calls[0]?.[0]).toBe("c_alpha");
  });

  it("does the whole refresh inside one scope", async () => {
    /*
     * One statement, one snapshot. The point of the rollup is that computed_at
     * describes a moment every figure was simultaneously true, and two calls
     * would be two snapshots under one stamp.
     */
    await handleDashboardRollup({ companyId: "c_alpha" });

    expect(refreshDashboardRollup).toHaveBeenCalledTimes(1);
  });
});

describe("the bounds", () => {
  it("computes them when it runs, not when it was registered", async () => {
    /*
     * The fault this exists for. Run the same job twice on two different
     * platform days and the boundaries must differ - a payload-carried bound,
     * or a module-level constant, gives the same answer both times.
     */
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    await handleDashboardRollup({ companyId: "c_alpha" });
    const first = boundsPassed();

    refreshDashboardRollup.mockClear();

    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    await handleDashboardRollup({ companyId: "c_alpha" });
    const second = boundsPassed();

    expect(second.dayStart.getTime()).toBeGreaterThan(first.dayStart.getTime());
    expect(second.computedAt.getTime()).toBeGreaterThan(
      first.computedAt.getTime(),
    );
  });

  it("uses the platform day, not the server's", async () => {
    vi.useFakeTimers();
    /* 18:45 UTC is 00:15 the NEXT day in IST, which is where a UTC-derived
       boundary lands a whole day out and nowhere else. */
    vi.setSystemTime(new Date("2026-09-01T18:45:00.000Z"));

    await handleDashboardRollup({ companyId: "c_alpha" });

    /* Exact instants, never a tolerance - a tolerant comparison passes on a UTC
       machine and hides the fault on every other one. */
    expect(boundsPassed().dayStart.toISOString()).toBe(
      "2026-09-01T18:30:00.000Z",
    );
    expect(boundsPassed().monthStart.toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
  });

  it("stamps computed_at with the moment it ran", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-01T12:34:56.000Z");
    vi.setSystemTime(now);

    const result = await handleDashboardRollup({ companyId: "c_alpha" });

    /*
     * The freshness line on the page is computed from this and nothing else, so
     * a value that is not the run's own instant makes the age it prints a claim
     * about nothing at all.
     */
    expect(boundsPassed().computedAt.toISOString()).toBe(now.toISOString());
    expect(result.computedAt).toBe(now.toISOString());
  });
});

describe("failure", () => {
  it("propagates, so BullMQ retries and the previous row survives", async () => {
    /*
     * Deliberately not swallowed. Nothing here reaches a customer and nothing
     * is charged, so a retry costs a scan - and a failed refresh leaves the
     * last row in place, which the page renders honestly as older figures with
     * their age beside them rather than as zeroes.
     */
    withCompany.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(
      handleDashboardRollup({ companyId: "c_alpha" }),
    ).rejects.toThrow("connection terminated");
  });
});
