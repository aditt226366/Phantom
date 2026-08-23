import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  describeWindow,
  isWindowOpen,
  windowExpiryFor,
} from "../src/whatsapp/window.ts";
import { sendPolicy, type SendFacts } from "../src/whatsapp/send-policy.ts";

const EXPIRY = new Date("2026-08-15T12:00:00.000Z");
const at = (ms: number) => new Date(EXPIRY.getTime() - ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("describeWindow", () => {
  it("is closed exactly at the expiry instant", () => {
    /*
     * The boundary, and it is `<= 0` rather than `< 0` on purpose. At exactly
     * the expiry Meta has stopped accepting free-form messages; being open for
     * the final millisecond is a race the send path loses anyway.
     */
    expect(describeWindow(EXPIRY, EXPIRY)).toEqual({ kind: "closed" });
  });

  it("is closed after it", () => {
    expect(describeWindow(EXPIRY, new Date(EXPIRY.getTime() + 1))).toEqual({
      kind: "closed",
    });
    expect(describeWindow(EXPIRY, new Date(EXPIRY.getTime() + HOUR))).toEqual({
      kind: "closed",
    });
  });

  it("is closing with one minute left at the last millisecond", () => {
    expect(describeWindow(EXPIRY, at(1))).toEqual({ kind: "closing", minutes: 1 });
  });

  it("counts minutes below the hour, rounded up", () => {
    /* Rounded up, so "1 minute left" means some time remains rather than none.
       Rounding down would print "0 minutes" on an open window. */
    expect(describeWindow(EXPIRY, at(MINUTE))).toEqual({
      kind: "closing",
      minutes: 1,
    });
    expect(describeWindow(EXPIRY, at(MINUTE + 1))).toEqual({
      kind: "closing",
      minutes: 2,
    });
    expect(describeWindow(EXPIRY, at(59 * MINUTE))).toEqual({
      kind: "closing",
      minutes: 59,
    });
  });

  it("switches to hours exactly at one hour remaining", () => {
    /* The other boundary. One second under is minutes; exactly on it is hours. */
    expect(describeWindow(EXPIRY, at(HOUR - 1))).toEqual({
      kind: "closing",
      minutes: 60,
    });
    expect(describeWindow(EXPIRY, at(HOUR))).toEqual({ kind: "open", hours: 1 });
  });

  it("counts hours above it, rounded up", () => {
    expect(describeWindow(EXPIRY, at(HOUR + 1))).toEqual({ kind: "open", hours: 2 });
    expect(describeWindow(EXPIRY, at(23 * HOUR))).toEqual({
      kind: "open",
      hours: 23,
    });
    expect(describeWindow(EXPIRY, at(CUSTOMER_SERVICE_WINDOW_MS))).toEqual({
      kind: "open",
      hours: 24,
    });
  });

  it("treats a conversation with no inbound message as closed", () => {
    /*
     * Null is not "open indefinitely". A conversation created by an outbound
     * template has never received anything, so there is no window at all - and
     * defaulting the other way would let free-form messages out of a thread
     * the customer has never replied in.
     */
    expect(describeWindow(null, EXPIRY)).toEqual({ kind: "closed" });
    expect(describeWindow(undefined, EXPIRY)).toEqual({ kind: "closed" });
  });

  it("derives the expiry from the last inbound message", () => {
    const inbound = new Date("2026-08-14T12:00:00.000Z");
    expect(windowExpiryFor(inbound)).toEqual(EXPIRY);
  });

  it("agrees with isWindowOpen on every kind", () => {
    expect(isWindowOpen({ kind: "closed" })).toBe(false);
    expect(isWindowOpen({ kind: "closing", minutes: 1 })).toBe(true);
    expect(isWindowOpen({ kind: "open", hours: 24 })).toBe(true);
  });
});

const OPEN: SendFacts = {
  window: { kind: "open", hours: 5 },
  numberStatus: "CONNECTED",
  companyDeactivated: false,
  contactOptedOut: false,
};

describe("sendPolicy", () => {
  it("allows a free-form reply inside the window", () => {
    expect(sendPolicy(OPEN, { kind: "freeform" })).toEqual({ allowed: true });
  });

  it("allows one with a minute left", () => {
    expect(
      sendPolicy(
        { ...OPEN, window: { kind: "closing", minutes: 1 } },
        { kind: "freeform" },
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses free-form once the window has closed", () => {
    expect(
      sendPolicy({ ...OPEN, window: { kind: "closed" } }, { kind: "freeform" }),
    ).toEqual({ allowed: false, reason: "window_closed" });
  });

  it("refuses a template until 4b, whatever the window says", () => {
    /* The one arm 4b flips. Nothing exists to send yet, so the window is not
       the reason and must not be reported as one. */
    for (const window of [
      { kind: "open", hours: 5 } as const,
      { kind: "closed" } as const,
    ]) {
      expect(
        sendPolicy({ ...OPEN, window }, { kind: "template", approved: true }),
      ).toEqual({ allowed: false, reason: "template_not_available" });
    }
  });

  it("fails closed on a number Meta has told us nothing about", () => {
    /*
     * Operationally: a number whose metadata has never been fetched cannot
     * send. The refresh job runs after verification, so the ordinary path is
     * connect, verify, refresh, send. Sending from a number Meta may have
     * restricted is what costs a customer their account.
     */
    expect(
      sendPolicy({ ...OPEN, numberStatus: "UNKNOWN" }, { kind: "freeform" }),
    ).toEqual({ allowed: false, reason: "number_status_unknown" });
  });

  it("refuses a number that is not in a sendable state", () => {
    for (const status of ["PENDING", "RESTRICTED"]) {
      expect(
        sendPolicy({ ...OPEN, numberStatus: status }, { kind: "freeform" }),
        status,
      ).toEqual({ allowed: false, reason: "number_not_sendable" });
    }
  });

  it("treats a status Meta invented after this build as unknown", () => {
    /*
     * The column is text as of 20260816100000, so a status this build has never
     * seen reaches sendPolicy verbatim instead of arriving pre-flattened into
     * UNKNOWN by the enum.
     *
     * Both arms refuse, so the safety is identical either way. What is asserted
     * here is which refusal: `number_not_sendable` would claim knowledge we do
     * not have and send an operator looking for a restriction that may not
     * exist, while `number_status_unknown` says the true thing.
     */
    for (const status of ["BANNED", "MIGRATED", "RATE_LIMITED", "UNVERIFIED", "🙃"]) {
      expect(
        sendPolicy({ ...OPEN, numberStatus: status }, { kind: "freeform" }),
        status,
      ).toEqual({ allowed: false, reason: "number_status_unknown" });
    }
  });

  it("still sends from a flagged number", () => {
    /* FLAGGED means Meta is watching the quality, not that messaging stopped.
       Refusing would take a customer's messaging away before Meta did. */
    expect(
      sendPolicy({ ...OPEN, numberStatus: "FLAGGED" }, { kind: "freeform" }),
    ).toEqual({ allowed: true });
  });

  it("reports the least recoverable reason first", () => {
    /*
     * Ordering is the point. Telling somebody "the window has closed, send a
     * template" when the contact has opted out is advice toward a worse
     * outcome, so the unrecoverable refusals are reported ahead of the window
     * even when both apply.
     */
    const everythingWrong: SendFacts = {
      window: { kind: "closed" },
      numberStatus: "RESTRICTED",
      companyDeactivated: true,
      contactOptedOut: true,
    };

    expect(sendPolicy(everythingWrong, { kind: "freeform" })).toEqual({
      allowed: false,
      reason: "company_deactivated",
    });

    expect(
      sendPolicy(
        { ...everythingWrong, companyDeactivated: false },
        { kind: "freeform" },
      ),
    ).toEqual({ allowed: false, reason: "contact_opted_out" });

    expect(
      sendPolicy(
        { ...everythingWrong, companyDeactivated: false, contactOptedOut: false },
        { kind: "freeform" },
      ),
    ).toEqual({ allowed: false, reason: "number_not_sendable" });
  });

  it("returns a code, never a sentence", () => {
    /*
     * The reason reaches a message bubble, the logs and 4b's flipped arm. Prose
     * would get matched on - `reason.includes("window")` works until the copy
     * is reworded. Asserted as an exact value against a closed set.
     */
    const codes = new Set([
      "window_closed",
      "number_not_sendable",
      "number_status_unknown",
      "company_deactivated",
      "contact_opted_out",
      "template_not_available",
      "template_not_approved",
    ]);

    const refusals = [
      sendPolicy({ ...OPEN, companyDeactivated: true }, { kind: "freeform" }),
      sendPolicy({ ...OPEN, contactOptedOut: true }, { kind: "freeform" }),
      sendPolicy({ ...OPEN, numberStatus: "UNKNOWN" }, { kind: "freeform" }),
      sendPolicy({ ...OPEN, numberStatus: "RESTRICTED" }, { kind: "freeform" }),
      sendPolicy({ ...OPEN, window: { kind: "closed" } }, { kind: "freeform" }),
      sendPolicy(OPEN, { kind: "template", approved: false }),
    ];

    for (const decision of refusals) {
      expect(decision.allowed).toBe(false);
      if (decision.allowed) continue;
      expect(codes.has(decision.reason), decision.reason).toBe(true);
      expect(decision.reason).not.toMatch(/\s/);
    }
  });
});
