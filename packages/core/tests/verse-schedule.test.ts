import { describe, expect, it } from "vitest";

import {
  MINUTES_IN_DAY,
  formatMinutes,
  localDay,
  localMinutes,
  maySend,
  parseMinutes,
  templateStopReason,
  templateStopsCampaign,
  type Schedule,
} from "../src/verse/schedule.ts";

/**
 * When a campaign may speak.
 *
 * Every fault in this module is an off-by-one-hour that appears in some
 * timezones and not others, or on one side of a DST transition and not the
 * other - so the assertions below are exact instants in named zones rather
 * than "roughly the right time", and several of them would pass in Asia/Kolkata
 * while failing in Europe/London on purpose.
 *
 * The product failure being prevented is a phone buzzing at two in the morning,
 * which costs the tenant a customer and possibly a complaint to Meta about
 * their number.
 */

const IST = "Asia/Kolkata";
const LONDON = "Europe/London";

/** An instant, named by what it is in the zone under test. */
const at = (iso: string) => new Date(iso);

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    timezone: IST,
    windowStartMinute: 9 * 60,
    windowEndMinute: 20 * 60,
    dailyCap: null,
    ...overrides,
  };
}

describe("localMinutes", () => {
  it("reads the wall clock in the tenant's zone, not the server's", () => {
    /* 06:00 UTC is 11:30 in Kolkata. A server-clock reading would say 360. */
    expect(localMinutes(at("2026-09-02T06:00:00Z"), IST)).toBe(11 * 60 + 30);
  });

  it("puts local midnight at zero, never at 1440", () => {
    /*
     * The bug this exists for. `hour12: false` renders midnight as "24" in
     * some runtimes - a real difference between Node versions - which puts
     * midnight at minute 1440, outside every window ending at 1440. A campaign
     * with a window would go silent for exactly one minute a day and nobody
     * would ever find it.
     */
    expect(localMinutes(at("2026-09-01T18:30:00Z"), IST)).toBe(0);
    expect(localMinutes(at("2026-09-02T00:00:00Z"), LONDON)).toBe(60);
  });

  it("follows a DST transition rather than a stored offset", () => {
    /*
     * The reason the column is an IANA name. London is UTC+1 in September and
     * UTC+0 in December; a campaign configured in summer with a stored "+01:00"
     * would start messaging people an hour early all winter.
     *
     * India does not observe DST, which is exactly why an offset would ship
     * working here and break for the first tenant outside it.
     */
    expect(localMinutes(at("2026-09-02T12:00:00Z"), LONDON)).toBe(13 * 60);
    expect(localMinutes(at("2026-12-02T12:00:00Z"), LONDON)).toBe(12 * 60);
  });
});

describe("localDay", () => {
  it("is the tenant's calendar day, not the server's", () => {
    /*
     * 20:00 UTC is already tomorrow in Kolkata. A cap keyed on the server's day
     * would reset at 05:30 local - the middle of a tenant's morning - and they
     * would report it as the cap not working.
     */
    expect(localDay(at("2026-09-02T20:00:00Z"), IST)).toBe("2026-09-03");
    expect(localDay(at("2026-09-02T20:00:00Z"), LONDON)).toBe("2026-09-02");
  });
});

describe("maySend — the daily window", () => {
  it("sends inside the window", () => {
    /* 09:00 UTC is 14:30 IST, inside 09:00-20:00. */
    expect(maySend(schedule(), 0, at("2026-09-02T09:00:00Z"))).toEqual({
      kind: "send",
    });
  });

  it("refuses before the window opens, and says when it reopens", () => {
    /* 02:00 UTC is 07:30 IST. The window opens at 09:00, ninety minutes on. */
    const verdict = maySend(schedule(), 0, at("2026-09-02T02:00:00Z"));

    expect(verdict.kind).toBe("outside_window");
    if (verdict.kind !== "outside_window") throw new Error("unreachable");
    expect(verdict.resumesInMinutes).toBe(90);
  });

  it("refuses after the window closes, and wraps to tomorrow's opening", () => {
    /* 16:00 UTC is 21:30 IST, past a 20:00 close. Tomorrow opens at 09:00,
       which is 11.5 hours away. */
    const verdict = maySend(schedule(), 0, at("2026-09-02T16:00:00Z"));

    expect(verdict.kind).toBe("outside_window");
    if (verdict.kind !== "outside_window") throw new Error("unreachable");
    expect(verdict.resumesInMinutes).toBe(11 * 60 + 30);
  });

  /* --------------------------------------------------------------------- *
   * The boundaries, asserted from both sides
   * --------------------------------------------------------------------- */

  it("sends at the exact minute the window opens", () => {
    /* 03:30 UTC is 09:00 IST exactly. */
    expect(maySend(schedule(), 0, at("2026-09-02T03:30:00Z")).kind).toBe("send");
  });

  it("refuses at the exact minute the window closes", () => {
    /*
     * 14:30 UTC is 20:00 IST exactly. Half-open: a window "until 20:00" that
     * still sends AT 20:00 is a window that sends one minute past every
     * boundary a tenant configured, which is the whole thing they were
     * avoiding. Both sides asserted, because a one-sided check passes for a
     * window an hour wider.
     */
    expect(maySend(schedule(), 0, at("2026-09-02T14:30:00Z")).kind).toBe(
      "outside_window",
    );
    /* One minute before close still sends. */
    expect(maySend(schedule(), 0, at("2026-09-02T14:29:00Z")).kind).toBe("send");
  });

  it("sends at any hour when no window is set", () => {
    const always = schedule({ windowStartMinute: null, windowEndMinute: null });

    expect(maySend(always, 0, at("2026-09-01T20:30:00Z")).kind).toBe("send");
  });

  it("keeps a window in the tenant's zone across a DST change", () => {
    /*
     * 08:30 UTC is 09:30 in London in September and 08:30 in December. A 09:00
     * window sends in September and refuses in December, from the same instant
     * - which is correct, and is what a stored offset would get wrong.
     */
    const london = schedule({ timezone: LONDON });

    expect(maySend(london, 0, at("2026-09-02T08:30:00Z")).kind).toBe("send");
    expect(maySend(london, 0, at("2026-12-02T08:30:00Z")).kind).toBe(
      "outside_window",
    );
  });
});

describe("maySend — the daily cap", () => {
  it("sends below the cap", () => {
    expect(
      maySend(schedule({ dailyCap: 100 }), 99, at("2026-09-02T09:00:00Z")).kind,
    ).toBe("send");
  });

  it("refuses at the cap, and names it", () => {
    /*
     * Both sides again. `sentToday >= cap` and not `>`: a cap of 100 that
     * sends a hundred and first message is a cap nobody set.
     */
    const verdict = maySend(
      schedule({ dailyCap: 100 }),
      100,
      at("2026-09-02T09:00:00Z"),
    );

    expect(verdict.kind).toBe("cap_reached");
    if (verdict.kind !== "cap_reached") throw new Error("unreachable");
    expect(verdict.cap).toBe(100);
  });

  it("sends without limit when no cap is set", () => {
    expect(
      maySend(schedule({ dailyCap: null }), 100_000, at("2026-09-02T09:00:00Z"))
        .kind,
    ).toBe("send");
  });

  it("reports the window before the cap", () => {
    /*
     * The verdict names the reason a person would act on first. "It is 2am" is
     * a different message from "you have used today's allowance", and a
     * campaign outside its window has usually not spent anything at all.
     */
    const verdict = maySend(
      schedule({ dailyCap: 10 }),
      50,
      at("2026-09-01T20:00:00Z"),
    );

    expect(verdict.kind).toBe("outside_window");
  });
});

describe("the template that stops a campaign", () => {
  it.each(["REJECTED", "PAUSED", "DISABLED"])("stops on %s", (status) => {
    /*
     * Meta can revoke an approval mid-flight and does, for quality signals it
     * does not explain in advance. Unchecked, every remaining send is refused
     * one message at a time while the campaign appears to run normally - and
     * the tenant finds out from their delivery numbers days later.
     */
    expect(templateStopsCampaign(status)).toBe(true);
    /* And says why, in words naming what to do about it. */
    expect(templateStopReason(status).length).toBeGreaterThan(40);
  });

  it.each(["APPROVED", "PENDING"])("keeps running on %s", (status) => {
    expect(templateStopsCampaign(status)).toBe(false);
  });

  it("explains a status it does not recognise rather than claiming success", () => {
    /* Meta has shipped new status strings before. An unrecognised one must not
       silently read as "fine to send". */
    expect(templateStopReason("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });
});

describe("formatting a time", () => {
  it("round-trips", () => {
    expect(parseMinutes(formatMinutes(540))).toBe(540);
    expect(formatMinutes(0)).toBe("00:00");
    expect(formatMinutes(MINUTES_IN_DAY - 1)).toBe("23:59");
  });

  it.each(["9:00", "09:00", "23:59"])("parses %s", (value) => {
    expect(parseMinutes(value)).not.toBeNull();
  });

  it.each(["", "24:00", "09:60", "nine", "09-00"])("refuses %j", (value) => {
    expect(parseMinutes(value)).toBeNull();
  });
});
