import { describe, expect, it } from "vitest";
import { MESSAGE_STATUSES } from "@whatsapp-os/core/whatsapp";
import { refusalSentence, statusDisplay } from "../../lib/thread-display.ts";

describe("statusDisplay", () => {
  /*
   * The ladder is an enum, and a member added on one side only would render as
   * its own raw name in a bubble — legible, but not the sentence somebody needs
   * for HELD or UNCONFIRMED. Comparing against the exported list means adding a
   * status fails here rather than shipping a thread that says "UNCONFIRMED".
   */
  it("has a phrase for every member of the ladder", () => {
    for (const status of MESSAGE_STATUSES) {
      expect(statusDisplay(status).label, status).not.toBe(status);
    }
  });

  /*
   * The two that must carry a sentence. Both are outcomes a person has to act
   * on and both have a one-word label that misleads on its own: "Held" reads as
   * a queue position, and "Delivery unknown" without the warning invites the
   * retry that sends a customer the same message twice.
   */
  it.each(["HELD", "UNCONFIRMED"])("explains %s rather than naming it", (status) => {
    expect(statusDisplay(status).detail).toBeTruthy();
  });

  it("warns that retrying an unconfirmed send may deliver it twice", () => {
    expect(statusDisplay("UNCONFIRMED").detail).toMatch(/twice/i);
  });

  it("tones the ends of the ladder apart", () => {
    expect(statusDisplay("FAILED").tone).toBe("error");
    expect(statusDisplay("READ").tone).toBe("success");
    expect(statusDisplay("SENT").tone).toBe("muted");
  });
});

describe("refusalSentence", () => {
  /*
   * send-policy returns machine codes and says the human sentence belongs where
   * it is displayed. A missing entry would render as undefined next to a
   * disabled composer — a control that is off for no stated reason.
   */
  it.each([
    "window_closed",
    "number_not_sendable",
    "number_status_unknown",
    "company_deactivated",
    "contact_opted_out",
    "template_not_available",
    "template_not_approved",
  ] as const)("has a sentence for %s", (reason) => {
    const sentence = refusalSentence(reason);
    expect(sentence).toBeTruthy();
    expect(sentence).not.toContain("_");
  });

  it("tells somebody what to do about a closed window", () => {
    expect(refusalSentence("window_closed")).toMatch(/template/i);
  });
});
