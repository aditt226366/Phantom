import { describe, expect, it } from "vitest";
import {
  classifyBulkError,
  describeDuration,
  estimatedDurationMs,
  sendDelayMs,
  tierCapacity,
  tierHeadroom,
} from "../src/bulk/index.ts";

/**
 * The two ceilings, and the codes that mean one has been hit.
 *
 * Confusing the gap with the tier is the mistake this file exists to prevent.
 * The gap is our pacing and Meta has no opinion about it; the tier is Meta's
 * cap on unique recipients per rolling 24 hours, and no amount of slowing down
 * gets past it. A broadcast paced perfectly and larger than the tier does not
 * fail at the end - it fails partway through, having already messaged part of
 * the list.
 */

describe("what we know about a tier", () => {
  it("reads the tiers Meta currently documents", () => {
    expect(tierCapacity("TIER_1K")).toEqual({
      known: true,
      unlimited: false,
      capacity: 1_000,
    });
  });

  it("distinguishes unlimited from unknown", () => {
    /*
     * The whole reason this returns a shape rather than a number. "Meta
     * imposes no cap" and "we have not been told what the cap is" are
     * completely different things to put in front of somebody about to message
     * ten thousand people, and one number would have to lie about one of them.
     */
    expect(tierCapacity("TIER_UNLIMITED")).toEqual({ known: true, unlimited: true });
    expect(tierCapacity(null)).toEqual({ known: false });
    expect(tierCapacity("TIER_SOMETHING_NEW")).toEqual({ known: false });
  });
});

describe("headroom", () => {
  it("subtracts what the number has already used in the window", () => {
    const headroom = tierHeadroom("TIER_1K", 300, 500);

    expect(headroom.remaining).toBe(700);
    expect(headroom.over).toBe(0);
  });

  it("says by how much an audience overshoots", () => {
    /*
     * The number the confirm screen leads with. "1,200 recipients" beside
     * "500 left today" is a run that stops two fifths of the way through, and
     * the tenant needs to know that before pressing send rather than from a
     * report afterwards.
     */
    const headroom = tierHeadroom("TIER_1K", 500, 1_200);

    expect(headroom.remaining).toBe(500);
    expect(headroom.over).toBe(700);
  });

  it("never reports negative headroom", () => {
    /* A number already over its cap - possible, because Meta counts things we
       do not see. Zero left is the honest answer; minus fifty is not. */
    expect(tierHeadroom("TIER_250", 300, 10).remaining).toBe(0);
  });

  it("does not block on a tier it cannot read", () => {
    /*
     * Failing closed here would stop a tenant broadcasting because a metadata
     * refresh has not run - a self-inflicted outage for a limit Meta enforces
     * itself. What protects the run instead is the backoff: 130472 and 131049
     * arrive when the cap is really hit.
     */
    const headroom = tierHeadroom(null, 0, 50_000);

    expect(headroom.remaining).toBeNull();
    expect(headroom.over, "an unreadable tier blocked a send").toBe(0);
  });

  it("does not cap an unlimited number", () => {
    const headroom = tierHeadroom("TIER_UNLIMITED", 90_000, 50_000);

    expect(headroom.remaining).toBeNull();
    expect(headroom.over).toBe(0);
  });
});

describe("what Meta's refusals mean for a run", () => {
  it("backs off on every documented rate limit", () => {
    /*
     * Four codes, one response. The distinction between them is not ours to
     * act on: what matters is that all four mean the run cannot usefully
     * continue right now, and continuing damages the number's quality rating.
     */
    for (const code of [131049, 130472, 131056, 133016]) {
      expect(classifyBulkError(code), `${code} did not back off`).toBe("backoff");
    }
  });

  it("marks a handset that cannot receive WhatsApp", () => {
    /* A fact about the number, not about us, so it is remembered and skipped
       in every future broadcast rather than retried per campaign. */
    expect(classifyBulkError(131026)).toBe("undeliverable");
  });

  it("lets an ordinary failure through without stopping the run", () => {
    /*
     * The important negative. If this returned "backoff" for anything
     * unrecognised, one bad recipient would halt a broadcast to ten thousand
     * people - and the symptom would be a run that mysteriously stops.
     */
    expect(classifyBulkError(131047)).toBe("continue");
    expect(classifyBulkError(null)).toBe("continue");
    expect(classifyBulkError(undefined)).toBe("continue");
  });
});

describe("pacing", () => {
  it("sends the first recipient immediately", () => {
    /* A broadcast that waited 800ms to start would look broken for the first
       second of every run anybody watched. */
    expect(sendDelayMs(0, 800)).toBe(0);
  });

  it("spaces the rest by the gap", () => {
    expect(sendDelayMs(1, 800)).toBe(800);
    expect(sendDelayMs(100, 800)).toBe(80_000);
  });

  it("counts gaps, not recipients, for the duration", () => {
    /* n recipients means n-1 gaps. A run of one takes no time at all, which is
       the right answer rather than an edge case. */
    expect(estimatedDurationMs(1, 800)).toBe(0);
    expect(estimatedDurationMs(2, 800)).toBe(800);
    expect(estimatedDurationMs(0, 800)).toBe(0);
  });

  it("agrees with the delay of the last recipient", () => {
    /*
     * The property that matters: the estimate on the confirm screen and the
     * delay actually handed to BullMQ are the same arithmetic. Two
     * implementations would drift, and the tenant would be told a duration the
     * run does not take.
     */
    for (const [count, gap] of [
      [1, 800],
      [50, 800],
      [1_204, 500],
    ] as const) {
      expect(estimatedDurationMs(count, gap)).toBe(sendDelayMs(count - 1, gap));
    }
  });

  it("describes a duration in units a person reads", () => {
    expect(describeDuration(0)).toBe("under a minute");
    expect(describeDuration(60_000)).toBe("about 1 minute");
    expect(describeDuration(16 * 60_000)).toBe("about 16 minutes");
    expect(describeDuration(60 * 60_000)).toBe("about 1 hour");
    expect(describeDuration(130 * 60_000)).toBe("about 2 hours 10 minutes");
  });
});
