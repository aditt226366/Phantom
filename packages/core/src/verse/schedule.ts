/**
 * When a campaign may speak, in the tenant's own day.
 *
 * ---------------------------------------------------------------------------
 * Why any of this exists
 * ---------------------------------------------------------------------------
 *
 * A campaign is a machine that messages strangers on a schedule. The failure it
 * produces when unconstrained is not a crash - it is a phone buzzing at two in
 * the morning, which costs the tenant a customer and possibly a complaint to
 * Meta about their number.
 *
 * So a campaign carries a timezone, an optional daily window, and an optional
 * per-day cap, and this module answers one question: may it send right now.
 *
 * Everything here is pure and takes `now` as an argument, so a test can assert
 * an exact instant rather than a tolerance - which matters more than usual,
 * because every fault in this file is an off-by-one-hour that only appears in
 * some timezones and only at some times of year.
 */

/** Minutes past local midnight. 0 is 00:00, 1440 is the end of the day. */
export const MINUTES_IN_DAY = 1440;

export interface Schedule {
  /** An IANA name. Never an offset - see localMinutes. */
  timezone: string;
  /** Null for no window: send whenever the run reaches them. */
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  /** Null for no cap. */
  dailyCap: number | null;
}

export type SendVerdict =
  | { kind: "send" }
  /** Outside the daily window. `resumesInMinutes` is when it reopens. */
  | { kind: "outside_window"; resumesInMinutes: number }
  /** The cap is spent for the tenant's today. */
  | { kind: "cap_reached"; cap: number };

/**
 * Minutes past local midnight, in an IANA zone.
 *
 * ---------------------------------------------------------------------------
 * Intl rather than an offset, and this is the whole reason the column is a
 * zone name
 * ---------------------------------------------------------------------------
 *
 * A stored offset is wrong twice a year. A campaign configured in October with
 * "+05:30" keeps that offset through a DST change it does not observe, or - far
 * worse for a tenant in a zone that does - drifts an hour and starts messaging
 * people at 07:00 when the window said 08:00.
 *
 * India does not observe DST, which is exactly why this would ship working and
 * break for the first tenant outside it. The zone name is resolved against the
 * runtime's own tz database at the moment of the check, so it is right in every
 * zone and on both sides of every transition.
 */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? "0",
  );

  /*
   * en-GB renders midnight as 24 under hour12:false in some runtimes, which is
   * a real difference between Node versions rather than a hypothetical. Left
   * unhandled it puts midnight at minute 1440 - outside every window that ends
   * at 1440, so a campaign with a window would go silent for exactly one
   * minute a day and nobody would ever find it.
   */
  return (hour % 24) * 60 + minute;
}

/** The tenant's calendar day, as YYYY-MM-DD, for keying a daily count. */
export function localDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * May this campaign send right now.
 *
 * `sentToday` is counted by the caller against `localDay`, because "today" is
 * the tenant's day and not the server's - a cap of 200 that resets at UTC
 * midnight resets at 05:30 for an Indian tenant, in the middle of their
 * morning, and they would see it as the cap not working.
 *
 * The window is checked before the cap so the verdict names the reason a person
 * would act on first: "it is 2am" is a different message from "you have used
 * today's allowance", and a campaign outside its window has usually not spent
 * anything at all.
 */
export function maySend(
  schedule: Schedule,
  sentToday: number,
  now: Date,
): SendVerdict {
  if (schedule.windowStartMinute !== null && schedule.windowEndMinute !== null) {
    const minutes = localMinutes(now, schedule.timezone);

    if (minutes < schedule.windowStartMinute) {
      return {
        kind: "outside_window",
        resumesInMinutes: schedule.windowStartMinute - minutes,
      };
    }

    if (minutes >= schedule.windowEndMinute) {
      /*
       * Wraps to tomorrow's opening. The window cannot itself wrap midnight -
       * a CHECK refuses start >= end - because a wrapping window IS a 2am
       * window, and refusing to represent one is cheaper than validating every
       * read of it.
       */
      return {
        kind: "outside_window",
        resumesInMinutes:
          MINUTES_IN_DAY - minutes + schedule.windowStartMinute,
      };
    }
  }

  if (schedule.dailyCap !== null && sentToday >= schedule.dailyCap) {
    return { kind: "cap_reached", cap: schedule.dailyCap };
  }

  return { kind: "send" };
}

/** "09:00", for the wizard and the campaign page. */
export function formatMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "09:00" back to 540. Null when it is not a time. */
export function parseMinutes(value: string): number | null {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) return null;

  return hour * 60 + minute;
}

/**
 * Template states that stop a campaign dead.
 *
 * ---------------------------------------------------------------------------
 * Meta can revoke an approval mid-flight, and it is not rare
 * ---------------------------------------------------------------------------
 *
 * A template approved on Monday can be PAUSED or REJECTED on Wednesday, while a
 * campaign is halfway through its audience. Meta does this for quality signals
 * it does not explain in advance.
 *
 * What happens if nothing checks: every remaining send is refused by the Graph
 * API one message at a time, each one a failed row in the thread, and the
 * campaign appears to be running normally while achieving nothing. The tenant
 * finds out from their delivery numbers days later.
 *
 * So the campaign stops itself and says why. STOPPED rather than PAUSED,
 * because nobody chose it and resuming will not fix it - the fix is a new
 * template or an appeal to Meta.
 */
export const TEMPLATE_STATES_THAT_STOP: readonly string[] = [
  "REJECTED",
  "PAUSED",
  "DISABLED",
];

export function templateStopsCampaign(status: string): boolean {
  return TEMPLATE_STATES_THAT_STOP.includes(status);
}

export function templateStopReason(status: string): string {
  switch (status) {
    case "REJECTED":
      return "Meta rejected this campaign's template, so nothing further can be sent with it. Edit the template and resubmit it, then start a new campaign.";
    case "PAUSED":
      return "Meta paused this campaign's template, usually after negative feedback from recipients. It cannot be sent until Meta lifts the pause.";
    case "DISABLED":
      return "Meta disabled this campaign's template. It cannot be sent again - a new template is needed.";
    default:
      return `This campaign's template is ${status}, which cannot be sent.`;
  }
}
