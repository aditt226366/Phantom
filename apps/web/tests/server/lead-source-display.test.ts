import { describe, expect, it } from "vitest";
import {
  leadRowOutcome,
  leadStatusLabel,
  leadStatusSentence,
  leadStatusVariant,
  rejectBreakdown,
  rejectReasonLabel,
  sheetUrl,
} from "@/lib/lead-source-display";

/**
 * The presentation decisions, asserted as values.
 *
 * Extracted from the pages for the reason number-display.ts was: a check that
 * markup contains a word is not a test of a branch. "Reactivate" survived in a
 * neighbouring heading here once, and the assertion stayed green through the
 * deletion of the control it was watching.
 */

describe("the badge", () => {
  it("is green only while a binding is polling", () => {
    expect(leadStatusVariant("ACTIVE")).toBe("success");
  });

  it("is neutral for a binding somebody switched off", () => {
    /* Colouring the tenant's own decision red would be the page arguing with
       them. Paused is a state, not a fault. */
    expect(leadStatusVariant("PAUSED")).toBe("default");
  });

  it("is an error for a binding that has stopped reading", () => {
    expect(leadStatusVariant("ERROR")).toBe("error");
  });

  it("does not call a paused binding an error in its label either", () => {
    expect(leadStatusLabel("PAUSED")).toBe("Paused");
    expect(leadStatusLabel("ACTIVE")).toBe("Polling");
    expect(leadStatusLabel("ERROR")).toBe("Not reading");
  });
});

describe("the sentence under the badge", () => {
  it("carries Google's own reason when the sheet cannot be read", () => {
    /*
     * The point of the ERROR state. "We cannot see this sheet" and "Meta has
     * not approved this template" need completely different actions from the
     * same person, and a generic line gives them neither.
     */
    expect(leadStatusSentence("ERROR", "We cannot see that spreadsheet.")).toBe(
      "We cannot see that spreadsheet.",
    );
  });

  it("says something rather than nothing when no reason was recorded", () => {
    /* Should not happen. Rendered rather than hidden, because a blank
       explanation is how somebody notices the reporting itself is wrong. */
    expect(leadStatusSentence("ERROR", null)).toContain("did not record a reason");
  });

  it("does not show a stale error beside an active binding", () => {
    expect(leadStatusSentence("ACTIVE", "an old failure")).not.toContain(
      "an old failure",
    );
  });
});

describe("what happened to one lead", () => {
  const sent = (status: string, errorTitle: string | null = null) =>
    leadRowOutcome({
      state: "SENT" as const,
      skipReason: null,
      message: { status, errorTitle },
    });

  it("reads the message's status, not the row's", () => {
    /* A lead that became a message is an ordinary message from that point, and
       its status ladder is the truth about whether it arrived. The row only
       says whether we tried. */
    expect(sent("DELIVERED").label).toBe("Delivered");
    expect(sent("PENDING").label).toBe("Queued");
  });

  it("shows Meta's own reason on a failure", () => {
    expect(sent("FAILED", "Template paused by Meta").label).toBe(
      "Template paused by Meta",
    );
    expect(sent("FAILED", "Template paused by Meta").variant).toBe("error");
  });

  it("treats an unconfirmed delivery as an error, not a success", () => {
    /* Meta never answered. Rendering it green would claim something nobody
       knows. */
    expect(sent("UNCONFIRMED").variant).toBe("error");
  });

  it("shows a skipped row's reason", () => {
    expect(
      leadRowOutcome({
        state: "SKIPPED",
        skipReason: "Opted out, or the number cannot receive WhatsApp",
        message: null,
      }).label,
    ).toContain("Opted out");
  });

  it("makes a sent row with no message visible rather than blank", () => {
    /* The CHECK constraint forbids it, so seeing it means something else is
       wrong - and a blank cell is how that goes unnoticed. */
    const outcome = leadRowOutcome({ state: "SENT", skipReason: null, message: null });

    expect(outcome.variant).toBe("error");
    expect(outcome.label).toBe("No message recorded");
  });

  it("renders a status this build has never seen rather than hiding it", () => {
    expect(sent("SOMETHING_NEW").label).toBe("SOMETHING_NEW");
    expect(sent("SOMETHING_NEW").variant).toBe("default");
  });
});

describe("the reject breakdown", () => {
  it("uses the same wording bulk's rejects file uses", () => {
    /* Two wordings for one reason code is how a support conversation goes
       wrong. */
    expect(rejectReasonLabel("unparseable_phone")).toBe(
      "Not a number anyone can be reached on",
    );
  });

  it("renders a reason code it does not recognise rather than dropping it", () => {
    expect(rejectReasonLabel("something_new")).toBe("something_new");
  });

  it("orders largest first, and stably", () => {
    /* A screenshot notices an unstable order even when a person would not. */
    const rows = rejectBreakdown({
      missing_phone: 3,
      unparseable_phone: 9,
      duplicate_in_file: 3,
    });

    expect(rows.map((row) => row.reason)).toEqual([
      "unparseable_phone",
      "duplicate_in_file",
      "missing_phone",
    ]);
  });

  it("survives a column holding something that is not a tally", () => {
    /* jsonb holds whatever was written, including by a build that predates a
       field. A report that throws is worse than one that shows nothing. */
    expect(rejectBreakdown(null)).toEqual([]);
    expect(rejectBreakdown("nonsense")).toEqual([]);
    expect(rejectBreakdown([1, 2])).toEqual([]);
    expect(rejectBreakdown({ missing_phone: "many" })).toEqual([]);
  });

  it("drops a reason that has fallen to zero", () => {
    expect(rejectBreakdown({ missing_phone: 0 })).toEqual([]);
  });
});

describe("the link back into Google", () => {
  it("opens at the tab the binding actually reads", () => {
    expect(sheetUrl("abc123", 884)).toBe(
      "https://docs.google.com/spreadsheets/d/abc123/edit#gid=884",
    );
  });

  it("omits the fragment when no gid was recorded", () => {
    expect(sheetUrl("abc123", null)).toBe(
      "https://docs.google.com/spreadsheets/d/abc123/edit",
    );
  });

  it("keeps gid zero, which is a real tab", () => {
    /* The first tab of every spreadsheet. A falsy check here would send every
       tenant to whichever tab Google opens by default. */
    expect(sheetUrl("abc123", 0)).toContain("#gid=0");
  });
});
