/**
 * When "today" starts.
 *
 * ---------------------------------------------------------------------------
 * Why this is a constant and not the server's clock
 * ---------------------------------------------------------------------------
 *
 * A dashboard that says "API calls today" is making a claim about a window,
 * and the window has to be one somebody can reason about. Left to the server,
 * "today" is whatever zone the container happens to run in — UTC in
 * production, the developer's zone locally, and neither is the one the person
 * reading the number lives in.
 *
 * Concretely: with a UTC boundary, an operator in India opening the panel at
 * 9am is shown a window that began at 5:30am *their* time, and which quietly
 * rolled over an hour and a half earlier. The count is not wrong so much as it
 * is about a different day than the one they are having. Worse, it changes
 * meaning depending on where the process is deployed, without anything in the
 * interface saying so.
 *
 * So the platform has one business day, it is India's, it is computed
 * explicitly rather than inherited, and every card that shows a "today" figure
 * says which day it means.
 *
 * Change this and every historical comparison shifts. It is a business
 * decision, not a formatting one.
 */

export const PLATFORM_TIMEZONE = "Asia/Kolkata";

/** For a label beside any figure computed from these boundaries. */
export const PLATFORM_TIMEZONE_LABEL = "IST";

/**
 * Midnight, in the platform's zone, as a UTC instant.
 *
 * Built from the zone's own calendar fields rather than by adding a fixed
 * offset: an offset hardcodes +05:30, which is right for India and wrong the
 * moment this is pointed anywhere with daylight saving. Intl knows the rules;
 * arithmetic on a magic number does not.
 */
export function startOfPlatformDay(now: Date = new Date()): Date {
  return startOfZonedDay(now, PLATFORM_TIMEZONE);
}

/** Midnight on the first of the current month, in the platform's zone. */
export function startOfPlatformMonth(now: Date = new Date()): Date {
  const { year, month } = zonedParts(now, PLATFORM_TIMEZONE);
  return zonedMidnightToUtc(year, month, 1, PLATFORM_TIMEZONE);
}

export function startOfZonedDay(now: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  return zonedMidnightToUtc(year, month, day, timeZone);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields an observer in `timeZone` would read off a clock. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    /* 24-hour formatting renders midnight as 24 in some ICU versions. */
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The UTC instant at which a given wall-clock midnight occurs in `timeZone`.
 *
 * Guessed, then corrected by the offset the guess turns out to have — the
 * standard trick, and correct across a DST boundary because the correction is
 * measured at the guessed instant rather than assumed.
 */
function zonedMidnightToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

/** How far ahead of UTC `timeZone` is at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    instant.getUTCMilliseconds(),
  );

  return asUtc - instant.getTime();
}
