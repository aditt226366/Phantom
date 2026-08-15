import { describe, expect, it } from "vitest";
import {
  PLATFORM_TIMEZONE,
  startOfPlatformDay,
  startOfPlatformMonth,
  startOfZonedDay,
} from "../src/time.ts";

/**
 * The day boundary, against instants worked out by hand.
 *
 * Every expected value here is a literal UTC timestamp rather than anything
 * derived from the function being tested. The first version of this check
 * computed its fixtures from startOfPlatformDay() and then asserted about
 * them, which is self-consistent whatever the function does — replacing the
 * whole implementation with a UTC boundary left it green.
 *
 * IST is UTC+05:30 with no daylight saving, so midnight IST is 18:30 UTC on
 * the previous day. That offset is the entire subject.
 */

describe("startOfPlatformDay", () => {
  it("returns 18:30 UTC the previous day", () => {
    /* 11:00 IST on 15 August. */
    const now = new Date("2026-08-15T05:30:00.000Z");

    expect(startOfPlatformDay(now).toISOString()).toBe(
      "2026-08-14T18:30:00.000Z",
    );
  });

  it("has already rolled over five minutes after IST midnight", () => {
    /* 00:05 IST on 15 August. */
    const now = new Date("2026-08-14T18:35:00.000Z");

    expect(startOfPlatformDay(now).toISOString()).toBe(
      "2026-08-14T18:30:00.000Z",
    );
  });

  it("has not rolled over five minutes before IST midnight", () => {
    /*
     * 23:55 IST on 14 August — still yesterday's window, and the case a UTC
     * boundary gets wrong by nearly six hours.
     */
    const now = new Date("2026-08-14T18:25:00.000Z");

    expect(startOfPlatformDay(now).toISOString()).toBe(
      "2026-08-13T18:30:00.000Z",
    );
  });

  it("differs from the UTC boundary, which is the point", () => {
    const now = new Date("2026-08-15T05:30:00.000Z");

    const utcMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    expect(startOfPlatformDay(now).getTime()).not.toBe(utcMidnight.getTime());
  });

  it("is exactly midnight when read back in the platform's zone", () => {
    const start = startOfPlatformDay(new Date("2026-08-15T05:30:00.000Z"));

    const wallClock = new Intl.DateTimeFormat("en-GB", {
      timeZone: PLATFORM_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(start);

    expect(wallClock).toBe("00:00");
  });
});

describe("startOfPlatformMonth", () => {
  it("is midnight IST on the first", () => {
    const now = new Date("2026-08-15T05:30:00.000Z");

    expect(startOfPlatformMonth(now).toISOString()).toBe(
      "2026-07-31T18:30:00.000Z",
    );
  });

  it("rolls into the new month at IST midnight, not UTC midnight", () => {
    /* 00:30 IST on 1 September = 19:00 UTC on 31 August. */
    const now = new Date("2026-08-31T19:00:00.000Z");

    expect(startOfPlatformMonth(now).toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
  });
});

describe("startOfZonedDay", () => {
  it("handles a zone that observes daylight saving", () => {
    /*
     * The reason the offset is measured rather than hardcoded. New York is
     * UTC-4 in August and UTC-5 in January; a fixed offset gets one of them
     * wrong by an hour, silently.
     */
    const summer = startOfZonedDay(
      new Date("2026-08-15T12:00:00.000Z"),
      "America/New_York",
    );
    const winter = startOfZonedDay(
      new Date("2026-01-15T12:00:00.000Z"),
      "America/New_York",
    );

    expect(summer.toISOString()).toBe("2026-08-15T04:00:00.000Z");
    expect(winter.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});
