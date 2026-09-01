import { describe, expect, it } from "vitest";
import { rollupFreshness } from "@whatsapp-os/core/dashboard";
import {
  ageLabel,
  freshnessLabel,
  minutesLeft,
  qualityIsCritical,
  qualityIsWarning,
  qualityTone,
  qualityWarning,
  sourceLabel,
  staleDayNotice,
  tierLabel,
} from "@/lib/dashboard/display";

/**
 * The dashboard's branches, asserted as values.
 *
 * Every one of these is a decision the page renders, and this repository has
 * already learned that asserting a rendered substring is not a test of one - a
 * check that the markup contained "Reactivate" stayed green after the control
 * was deleted, because the word survived in a neighbouring heading. So the
 * branches are functions and the assertions are on what they return.
 */

describe("number health, which is the card that matters", () => {
  it("treats a dropped rating as a warning under both of Meta's vocabularies", () => {
    /*
     * Meta reports quality as GREEN/YELLOW/RED on the Graph field and as
     * high/medium/low in Business Manager. The column is our enum and the
     * refresh maps into it - but a value that arrives unmapped must not read as
     * healthy, which is the only direction of this that can hurt anybody.
     */
    expect(qualityIsWarning("YELLOW")).toBe(true);
    expect(qualityIsWarning("MEDIUM")).toBe(true);
    expect(qualityIsCritical("RED")).toBe(true);
    expect(qualityIsCritical("LOW")).toBe(true);
  });

  it("does not call a healthy or unknown rating a warning", () => {
    expect(qualityIsWarning("GREEN")).toBe(false);
    expect(qualityIsCritical("GREEN")).toBe(false);
    expect(qualityIsWarning("UNKNOWN")).toBe(false);
  });

  it("never colours an unrecognised rating green", () => {
    /*
     * The tone falls back to neutral, not success. Meta extends this vocabulary
     * without notice, and a rating this build has never seen rendering as
     * healthy is the one failure of this card that would matter.
     */
    expect(qualityTone("GREEN")).toBe("success");
    expect(qualityTone("RED")).toBe("error");
    expect(qualityTone("YELLOW")).toBe("default");
    expect(qualityTone("SOMETHING_META_SHIPPED_TUESDAY")).toBe("default");
  });

  it("says what a dropped rating will cost, not just that it dropped", () => {
    const warning = qualityWarning("YELLOW");

    expect(warning).not.toBeNull();
    /* Names the consequence. "Quality: YELLOW" is a fact nobody outside Meta's
       documentation can act on. */
    expect(warning).toContain("restricts");
  });

  it("says nothing about a healthy number", () => {
    expect(qualityWarning("GREEN")).toBeNull();
  });

  it("renders a tier it has never seen as itself", () => {
    /* The tier vocabulary is Meta's and has changed twice. A tier shipped next
       month must render at 3am rather than be flattened to "Unknown". */
    expect(tierLabel("TIER_1K")).toBe("1,000 customers / day");
    expect(tierLabel("TIER_500K")).toBe("TIER_500K");
    expect(tierLabel(null)).toBe("Not reported");
  });
});

describe("freshness, which the page always states", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("distinguishes never-counted from counted-and-empty", () => {
    const label = freshnessLabel(rollupFreshness(null, now));

    expect(label).toContain("Not counted yet");
    /* And specifically does not claim an age it does not have. */
    expect(label).not.toContain("ago");
  });

  it("says a fresh reading is fresh, coarsely", () => {
    const label = freshnessLabel(
      rollupFreshness(new Date(now.getTime() - 20_000), now),
    );

    expect(label).toBe("Counted a moment ago");
  });

  it("says out loud when the refresh has stopped", () => {
    const label = freshnessLabel(
      rollupFreshness(new Date(now.getTime() - 7_200_000), now),
    );

    expect(label).toContain("2 hours ago");
    /* The figures are still shown. A page that hid them would be less useful
       than one that labels them. */
    expect(label).toContain("does not appear to be running");
  });
});

describe("the day the figures were counted against", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const fresh = rollupFreshness(new Date(now.getTime() - 30_000), now);

  it("warns when a perfectly fresh rollup counted yesterday", () => {
    /*
     * The fault a freshness check cannot see, and the reason this is a second
     * notice rather than part of the first. Both are about the same row and
     * only one of them looks wrong.
     */
    const notice = staleDayNotice(fresh, false);

    expect(notice).not.toBeNull();
    expect(notice).toContain("IST");
  });

  it("says nothing when the day is the one being had", () => {
    expect(staleDayNotice(fresh, true)).toBeNull();
  });

  it("says nothing at all when there is no rollup to describe", () => {
    /* Two notices about a page with no numbers on it is noise. */
    expect(staleDayNotice(rollupFreshness(null, now), false)).toBeNull();
  });
});

describe("ages", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("floors rather than rounds", () => {
    /*
     * A template submitted 110 minutes ago has been waiting one hour, not two.
     * An overstated delay is what makes somebody resubmit a template that was
     * about to be approved - and a resubmission spends one of Meta's edits.
     */
    expect(ageLabel(new Date(now.getTime() - 110 * 60_000), now)).toBe("1 hour");
    expect(ageLabel(new Date(now.getTime() - 47 * 3_600_000), now)).toBe("1 day");
  });

  it("reads naturally at the small end", () => {
    expect(ageLabel(new Date(now.getTime() - 20_000), now)).toBe("just now");
    expect(ageLabel(new Date(now.getTime() - 25 * 60_000), now)).toBe(
      "25 minutes",
    );
  });
});

describe("a closing window", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("is minutes remaining and never a clock time", () => {
    /*
     * Two reasons, and the second is a fixture rule. "Closes at 14:32" needs
     * the reader to know the time and the zone. And the visual suite seeds an
     * open window as now() + 18h - because a conversation cannot be both
     * permanently open and described by a fixed instant - so a page printing
     * the instant produces a baseline that never matches twice.
     */
    expect(minutesLeft(new Date(now.getTime() + 12 * 60_000), now)).toBe(12);
  });

  it("rounds up, so a window is never reported as already gone", () => {
    /* 90 seconds left is "2 minutes", not "1". Rounding down would show 0 for
       a window that is still open, and the link would look dead. */
    expect(minutesLeft(new Date(now.getTime() + 90_000), now)).toBe(2);
  });

  it("floors at zero rather than going negative", () => {
    expect(minutesLeft(new Date(now.getTime() - 60_000), now)).toBe(0);
  });
});

describe("where conversations came from", () => {
  it("does not claim to separate bulk from a lead source", () => {
    /*
     * conversation_source has one CAMPAIGN member and both producers write it.
     * Splitting them in the label would be a distinction the data does not
     * support - the card's footnote says so instead.
     */
    expect(sourceLabel("CAMPAIGN")).toBe("Campaign or lead source");
    expect(sourceLabel("INBOUND")).toBe("Customer wrote first");
  });

  it("renders a member it does not know as itself", () => {
    expect(sourceLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
