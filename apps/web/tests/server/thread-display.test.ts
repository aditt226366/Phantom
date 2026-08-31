import { describe, expect, it } from "vitest";
import { MESSAGE_STATUSES } from "@whatsapp-os/core/whatsapp";
import {
  refusalSentence,
  retryOffer,
  statusDisplay,
} from "../../lib/thread-display.ts";

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

describe("retryOffer", () => {
  /*
   * FAILED means Meta answered no, so non-delivery is proven and a retry
   * cannot duplicate anything. Offered plainly, with nothing to warn about.
   */
  it("offers a plain retry for a proven failure", () => {
    expect(retryOffer("FAILED", false)).toEqual({
      label: "Send again",
      warning: null,
    });
  });

  /*
   * UNCONFIRMED means Meta never answered. Nobody knows whether the customer
   * got it, and a second send cannot be un-sent - so the warning is not
   * optional decoration, it is the difference between the two offers.
   */
  it("never offers an unconfirmed retry without the warning", () => {
    const offer = retryOffer("UNCONFIRMED", false);
    expect(offer?.warning).toBeTruthy();
    expect(offer?.warning).toMatch(/twice/i);
  });

  /*
   * A wamid means Meta accepted and named the message, and the send worker
   * refuses to post one that already carries a name. A button here would
   * enqueue a job that does nothing - R2's dead-control failure by another
   * route - so the offer is withdrawn rather than drawn and ignored.
   */
  it.each(["FAILED", "UNCONFIRMED"])(
    "withdraws the offer for %s once Meta has named the message",
    (status) => {
      expect(retryOffer(status, true)).toBeNull();
    },
  );

  it.each(["PENDING", "SENT", "DELIVERED", "READ", "HELD"])(
    "does not offer %s",
    (status) => {
      expect(retryOffer(status, false)).toBeNull();
    },
  );
});
