import { describe, expect, it } from "vitest";
import {
  contactLabel,
  needsHuman,
  previewLabel,
  sourceLabel,
  windowLabel,
  windowVariant,
} from "../../lib/inbox-display.ts";

describe("contactLabel", () => {
  const waOnly = {
    displayName: null,
    profileName: null,
    phoneE164: null,
    waId: "919812345690",
  };

  it("prefers the name somebody here typed", () => {
    expect(
      contactLabel({ ...waOnly, displayName: "Vikram (PO)", profileName: "Vikram Shah" }),
    ).toBe("Vikram (PO)");
  });

  it("falls back through profile name, then number, then wa_id", () => {
    expect(contactLabel({ ...waOnly, profileName: "Anita Desai" })).toBe("Anita Desai");
    expect(contactLabel({ ...waOnly, phoneE164: "+919812345690" })).toBe("+919812345690");
    expect(contactLabel(waOnly)).toBe("919812345690");
  });

  /* Meta sends profile_name on the first inbound of a window and not reliably
     afterwards, so "no name at all" is ordinary. A blank here would be a row
     nobody could pick out of a list. */
  it("never returns an empty string", () => {
    expect(contactLabel(waOnly).length).toBeGreaterThan(0);
  });
});

describe("windowLabel", () => {
  /* C11. The fixture's open thread is stamped relative to the clock, so this
     may never render an instant — only a bucket. */
  it("says how long is left, never when", () => {
    expect(windowLabel({ kind: "open", hours: 18 })).toBe("18h left");
    expect(windowLabel({ kind: "closing", minutes: 45 })).toBe("45m left");
    expect(windowLabel({ kind: "closed" })).toBe("Window closed");
  });

  it.each([
    [{ kind: "open", hours: 18 } as const, "success"],
    [{ kind: "closing", minutes: 45 } as const, "default"],
    [{ kind: "closed" } as const, "outline"],
  ])("colours %o as %s", (state, expected) => {
    expect(windowVariant(state)).toBe(expected);
  });
});

describe("needsHuman", () => {
  it("flags an unanswered thread nobody has picked up", () => {
    expect(needsHuman({ assignedUserId: null, unreadCount: 2 })).toBe(true);
  });

  /*
   * Both halves matter, and each on its own produces a useless signal:
   * unassigned alone flags every thread ever answered and closed out, and
   * unread alone flags threads a colleague has already taken.
   */
  it("does not flag a thread somebody has taken", () => {
    expect(needsHuman({ assignedUserId: "user-1", unreadCount: 2 })).toBe(false);
  });

  it("does not flag a thread with nothing waiting", () => {
    expect(needsHuman({ assignedUserId: null, unreadCount: 0 })).toBe(false);
  });
});

describe("sourceLabel", () => {
  it("says how the thread started in words", () => {
    expect(sourceLabel("INBOUND")).toBe("Customer wrote first");
    expect(sourceLabel("ADS_CLICK_TO_WHATSAPP")).toBe("Ad click");
  });

  it("renders an unknown source as itself rather than as a blank", () => {
    expect(sourceLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("previewLabel", () => {
  it("names the absence rather than rendering an empty line", () => {
    expect(previewLabel(null)).toBe("No preview");
    expect(previewLabel("Yes please.")).toBe("Yes please.");
  });
});
