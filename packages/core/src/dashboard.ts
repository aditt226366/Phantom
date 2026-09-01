/**
 * The dashboard's arithmetic, with no database and no React in it.
 *
 * ---------------------------------------------------------------------------
 * Why the bounds are computed here rather than written into a WHERE clause
 * ---------------------------------------------------------------------------
 *
 * Every windowed query on this page binds two instants that were computed in
 * TypeScript and passed as parameters. None of them says `now()`.
 *
 * The reason usually given for that is a planner one, and on this database it
 * is WRONG - which is worth writing down, because it is the kind of claim that
 * gets repeated for years. The story goes: a range predicate built from `now()`
 * cannot be estimated, so the planner guesses one row and skips the index.
 *
 * It does not happen. `now()` is STABLE, not VOLATILE - its value is fixed for
 * the duration of a statement, so the planner evaluates it while planning and
 * estimates the range from the histogram exactly as it would a parameter.
 * Measured on Postgres 17.11 over 50,000 seeded conversations, the two forms
 * produce the SAME plan and the same row estimate:
 * `npm run db:explain:dashboard` prints both, side by side, so the next person
 * to wonder does not have to take this on trust. The rule still holds for a
 * genuinely volatile bound; `now()` is not one.
 *
 * What the bounds are actually for, and each of these is load-bearing:
 *
 *   1. The platform day has no SQL form. "Midnight in Asia/Kolkata, as a UTC
 *      instant" is Intl arithmetic - see time.ts - and writing it into a WHERE
 *      clause would mean hardcoding +05:30, which is right for India and wrong
 *      the moment this is pointed anywhere with daylight saving.
 *   2. A test can pass a fixed instant. Every exact-count assertion in
 *      packages/db/tests/dashboard-rollup.test.ts depends on it; against
 *      `now()` the whole suite would need the database's clock frozen.
 *   3. One clock across two processes. The worker stamps `computed_at` with the
 *      value it counted against, and the page compares the day boundary it was
 *      given with the boundary now. Neither is possible if the instant only
 *      ever exists inside a statement.
 *
 * ---------------------------------------------------------------------------
 * And why "today" is not the server's today
 * ---------------------------------------------------------------------------
 *
 * time.ts already argues this at length for the admin console. The dashboard
 * inherits it wholesale: one business day, India's, computed explicitly, and
 * labelled everywhere it is shown - because a card reading "new today" is a
 * claim about a window and the reader has to know which one.
 */

import { classifyBulkError } from "./bulk/limits.ts";
import {
  PLATFORM_TIMEZONE_LABEL,
  startOfPlatformDay,
  startOfPlatformMonth,
} from "./time.ts";

/**
 * How often the worker recomputes a company's rollup.
 *
 * Sixty seconds, which is the number the page's freshness line quotes. It is
 * here rather than at the scheduler because the reader of a stale rollup needs
 * the same constant to decide whether the age it is looking at is ordinary.
 */
export const DASHBOARD_ROLLUP_INTERVAL_SECONDS = 60;

/**
 * When an age stops being ordinary lateness and becomes something to say out
 * loud.
 *
 * Five intervals. One missed tick is a worker restart or a slow scan, and
 * describing that as a fault would train people to ignore the notice; five in a
 * row means the refresh is not running, and every number on the page is then a
 * historical record rather than a report. The page says so rather than dimming
 * the figures, because a number that is quietly five hours old is worse than
 * one labelled five hours old.
 */
export const DASHBOARD_ROLLUP_STALE_AFTER_SECONDS =
  DASHBOARD_ROLLUP_INTERVAL_SECONDS * 5;

/**
 * How far ahead the closing-windows card looks.
 *
 * An hour, because that is the horizon a person can still act inside. A day's
 * worth of expiring windows is a list nobody works through; the next sixty
 * minutes is a queue.
 */
export const CLOSING_WINDOW_HORIZON_MINUTES = 60;

/** Every instant the dashboard's queries bind, computed once per request. */
export interface DashboardWindows {
  /** The request's own clock reading. Every other field derives from it. */
  now: Date;
  /** Midnight in Asia/Kolkata, as a UTC instant. */
  dayStart: Date;
  /** The first of the month, same zone, same treatment. */
  monthStart: Date;
  /** The far edge of the closing-windows card. */
  closingHorizon: Date;
  /** For the label beside every figure derived from the two boundaries. */
  timezoneLabel: string;
}

export function dashboardWindows(now: Date = new Date()): DashboardWindows {
  return {
    now,
    dayStart: startOfPlatformDay(now),
    monthStart: startOfPlatformMonth(now),
    closingHorizon: new Date(
      now.getTime() + CLOSING_WINDOW_HORIZON_MINUTES * 60_000,
    ),
    timezoneLabel: PLATFORM_TIMEZONE_LABEL,
  };
}

/* ------------------------------------------------------------------------- *
   Freshness
   ------------------------------------------------------------------------- */

/**
 * How old the numbers are, as something the page can render.
 *
 * `never` is deliberately its own member rather than an infinitely stale
 * reading. A company whose rollup has never been computed - one created before
 * this phase, or one whose scheduler failed to register - must not be shown
 * zeroes. "Nothing has happened" and "we have not counted yet" are different
 * claims and only one of them is true, which is the same distinction
 * usage_events makes between a null cost and a zero one.
 */
export type RollupFreshness =
  | { state: "fresh"; computedAt: Date; ageSeconds: number }
  | { state: "stale"; computedAt: Date; ageSeconds: number }
  | { state: "never" };

export function rollupFreshness(
  computedAt: Date | null | undefined,
  now: Date = new Date(),
): RollupFreshness {
  if (!computedAt) return { state: "never" };

  /*
   * Clamped at zero. A rollup computed a second in the future is clock skew
   * between the worker and the web process, and "-1s ago" on a dashboard reads
   * as a bug in the page rather than as the two-second drift it is.
   */
  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - computedAt.getTime()) / 1000),
  );

  return {
    state:
      ageSeconds > DASHBOARD_ROLLUP_STALE_AFTER_SECONDS ? "stale" : "fresh",
    computedAt,
    ageSeconds,
  };
}

/**
 * Does the rollup's "today" mean the day the reader is having?
 *
 * The refresh stamps the platform-day boundary it counted against, and this
 * compares it with the boundary now. They differ for exactly one reason worth
 * catching: the rollup was computed before midnight IST and nothing has
 * recomputed it since, so its "new today" is a complete count of *yesterday*
 * being presented as a partial count of today.
 *
 * That is invisible to a freshness check alone - at 00:04 a rollup from 23:59
 * is five minutes old and perfectly fresh, and every "today" figure on it is
 * about the wrong day. The two checks catch different faults and the page runs
 * both.
 */
export function countedDayIsCurrent(
  countedDayStart: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!countedDayStart) return false;
  return countedDayStart.getTime() === startOfPlatformDay(now).getTime();
}

/* ------------------------------------------------------------------------- *
   Failures
   ------------------------------------------------------------------------- */

/**
 * Why outbound messages did not arrive, in the three groups a person can act
 * on.
 *
 * The rollup stores failures as a map of Meta's own error codes to counts, and
 * the grouping happens here rather than in SQL. Two reasons:
 *
 *   1. The code lists already exist, in bulk/limits.ts, and are consulted by
 *      the send worker on every refusal. A second copy inside a SQL string is
 *      a second place to update when Meta adds a code, and the one that would
 *      not be updated is the one nobody runs a test against.
 *   2. A stored aggregate keyed by code survives the classification changing.
 *      Re-grouping is a redeploy; re-counting is a scan of the messages table
 *      for every company.
 */
export interface FailureBreakdown {
  /**
   * Meta declined to deliver. 131049 and its three neighbours - the per-user
   * marketing limit, experiment groups, pair rate limits, and an outright rate
   * limit on the number.
   *
   * Grouped under one heading because the tenant's response to all four is the
   * same, and split out from `other` because it is the one that means the
   * *number* is in trouble rather than the message.
   */
  deliveryLimited: number;
  /** 131026: the handset cannot receive WhatsApp at all. */
  undeliverable: number;
  /** Everything else, including failures Meta gave no code for. */
  other: number;
  total: number;
}

export function summariseFailures(
  byCode: Readonly<Record<string, number>>,
): FailureBreakdown {
  const breakdown: FailureBreakdown = {
    deliveryLimited: 0,
    undeliverable: 0,
    other: 0,
    total: 0,
  };

  for (const [code, count] of Object.entries(byCode)) {
    if (!Number.isFinite(count) || count <= 0) continue;

    /*
     * The key is text because it came out of jsonb, and a key that is not a
     * number is a POLICY failure - our own refusal, which carries no Meta code
     * and is stored under a sentinel instead. classifyBulkError answers
     * "continue" for anything it does not recognise, which is `other`, which is
     * where a policy refusal belongs.
     */
    const parsed = Number.parseInt(code, 10);
    const action = classifyBulkError(Number.isNaN(parsed) ? null : parsed);

    if (action === "backoff") breakdown.deliveryLimited += count;
    else if (action === "undeliverable") breakdown.undeliverable += count;
    else breakdown.other += count;

    breakdown.total += count;
  }

  return breakdown;
}

/* ------------------------------------------------------------------------- *
   Money
   ------------------------------------------------------------------------- */

/**
 * One currency's spend, and never a total across two of them.
 *
 * The rollup stores this as a jsonb map of ISO 4217 code to a micros figure
 * *as a string*, and this is the type it is read back into. Both halves of that
 * are deliberate.
 *
 * The string, because JSON numbers are IEEE doubles and cost_micros is a
 * bigint. A million rupees is 10^12 micros, which is fine; ad spend over a year
 * is not necessarily, and a currency total that silently loses its last digits
 * above 2^53 is the worst possible way to find that out. Strings in, BigInt
 * out, arithmetic never touching a float.
 *
 * The map rather than a total, because adding ₹4,000 to $50 produces 4,050 of
 * nothing. There is no exchange rate in this system and there must not be one
 * invented at render time - so the shape the reader gets is a list, and a list
 * cannot be accidentally summed by a component that was written in a hurry.
 */
export interface CurrencySpend {
  /** ISO 4217, as stamped on the usage event. */
  currency: string;
  /** Millionths of one unit. 1_000_000 micros = one rupee. */
  micros: bigint;
}

/**
 * Parse the stored map into a stable, sorted list.
 *
 * Sorted by currency code rather than by size, so the order does not change
 * under the reader as spend moves. A dashboard whose rows reorder between two
 * refreshes is one where nobody notices a row appearing.
 */
export function currencySpend(
  byCurrency: Readonly<Record<string, string>>,
): CurrencySpend[] {
  return Object.entries(byCurrency)
    .map(([currency, micros]) => ({ currency, micros: BigInt(micros) }))
    .filter((entry) => entry.micros > 0n)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ------------------------------------------------------------------------- *
   Rates
   ------------------------------------------------------------------------- */

/**
 * A percentage, or null when there is nothing to divide by.
 *
 * Null rather than zero, for the reason the whole phase is built on: a rate
 * with no denominator is not 0%, it is an absence of evidence, and a bar drawn
 * at zero is a claim that nothing was delivered. The bars render an empty state
 * on null and a bar on a number.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}
