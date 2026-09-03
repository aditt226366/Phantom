import { describe, expect, it } from "vitest";
import {
  checkLinkedNumber,
  linkedNumberMessage,
} from "@/lib/meta-ads/linked-number";

/**
 * Whether a Page routes its click-to-WhatsApp replies somewhere this system
 * can see.
 *
 * The consequence of getting this wrong is narrow and expensive: the ads run,
 * the money is spent, and nothing arrives. So the tests below are mostly about
 * the two ways to be wrong - a false mismatch, which tells a correctly
 * configured tenant their setup is broken, and a false match, which tells a
 * broken one that it is fine.
 */

const OURS = [
  { id: "num-1", displayNumber: "+91 98765 43210" },
  { id: "num-2", displayNumber: "+91 90000 11111" },
];

describe("matching a Page's number against our own", () => {
  it("matches through different formatting on both sides", () => {
    /*
     * The false-mismatch case, and the reason the comparison is on digits.
     * Meta reports whatever shape the Page carries and our display number comes
     * from a different endpoint with its own. Comparing strings would report a
     * correctly linked Page as broken - a red warning on a setup that works,
     * on the one screen where this warning is meant to be believed.
     */
    for (const reported of [
      "+919876543210",
      "919876543210",
      "+91 98765 43210",
      "+91-98765-43210",
      "(91) 98765 43210",
    ]) {
      const verdict = checkLinkedNumber(reported, OURS);

      expect(verdict.kind, `${reported} should match`).toBe("matched");
      expect(verdict.kind === "matched" && verdict.whatsappNumberId).toBe("num-1");
    }
  });

  it("matches when one side carries a country code and the other does not", () => {
    /*
     * Neither source is authoritative about the prefix. Requiring exact
     * equality would report a mismatch whenever the two endpoints disagree
     * about it, which is common enough to make the warning noise.
     */
    expect(checkLinkedNumber("9876543210", OURS).kind).toBe("matched");
  });

  it("picks the right number when the tenant has several", () => {
    const verdict = checkLinkedNumber("+91 90000 11111", OURS);

    expect(verdict.kind === "matched" && verdict.whatsappNumberId).toBe("num-2");
  });

  it("says elsewhere for a number that is not ours, and names it", () => {
    /*
     * A real and ordinary arrangement - an agency running ads for a business
     * whose WhatsApp lives somewhere else - so it is a warning and never a
     * refusal. The number is carried through because "linked to a different
     * number" without saying which sends the tenant into Business Manager to
     * find out, which is what they came here to avoid.
     */
    const verdict = checkLinkedNumber("+91 91234 56789", OURS);

    expect(verdict.kind).toBe("elsewhere");
    expect(verdict.kind === "elsewhere" && verdict.linkedPhoneE164).toBe(
      "+91 91234 56789",
    );
    expect(linkedNumberMessage(verdict)).toContain("+91 91234 56789");
    expect(linkedNumberMessage(verdict)).toContain("will not appear in this inbox");
  });

  it("distinguishes a Page with no WhatsApp link at all", () => {
    /*
     * A different fact and a different remedy. "Linked elsewhere" means change
     * the Page or accept it; "not linked" means go and link one, or the ads
     * have nowhere to send anybody.
     */
    for (const empty of [null, "", "   "]) {
      expect(checkLinkedNumber(empty, OURS).kind).toBe("unlinked");
    }

    expect(linkedNumberMessage({ kind: "unlinked" })).toContain("no WhatsApp number");
  });

  it("refuses to match on a fragment too short to be sure", () => {
    /*
     * The false-match direction, which is the more expensive one: a tenant
     * told their attribution will work when it will not spends money before
     * discovering otherwise. Below ten significant digits a suffix match is a
     * coincidence, so the comparison falls back to equality.
     */
    expect(checkLinkedNumber("43210", OURS).kind).toBe("elsewhere");
    expect(checkLinkedNumber("0", OURS).kind).toBe("elsewhere");
  });

  it("says elsewhere rather than matched when we own no numbers at all", () => {
    /* A workspace with no WhatsApp number configured yet. There is nothing to
       match against, and claiming a match would be inventing one. */
    expect(checkLinkedNumber("+91 98765 43210", []).kind).toBe("elsewhere");
  });
});
