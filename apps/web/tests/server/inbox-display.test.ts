import { describe, expect, it } from "vitest";
import {
  contactLabel,
  needsHuman,
  previewLabel,
  sourceLabel,
  windowLabel,
  windowVariant,
  inboxWhere,
  parseInboxView,
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

describe("which conversations the inbox shows", () => {
  /**
   * The default view is the fix for a consequence of the model, not a change
   * to it. Bulk messaging creates a conversation per recipient - correctly,
   * because a customer who replies must land beside everybody else - and the
   * result is that a ten thousand recipient broadcast buries every genuine
   * conversation under one-way threads.
   *
   * Asserted as a value rather than by rendering, per the rule this repository
   * has learned twice: a page test that grepped for a class or a word would
   * pass on a filter that silently matched nothing.
   */
  it("defaults to threads a customer has written in", () => {
    expect(inboxWhere("replies")).toEqual({
      OR: [{ lastInboundAt: { not: null } }, { unreadCount: { gt: 0 } }],
    });
  });

  it("filters nothing on the all view", () => {
    /*
     * An empty object, not a clause that happens to match everything. The
     * second view has to be exactly what the inbox showed before this change,
     * or "all conversations" is a promise the page does not keep.
     */
    expect(inboxWhere("all")).toEqual({});
  });

  it("keeps unread threads even if the inbound clause ever stops implying them", () => {
    /*
     * Today unread_count is only incremented for an inbound message, so the
     * second clause is redundant. It is deliberate: the two facts mean
     * different things, and a thread somebody has not read belongs in this
     * view on its own merits rather than on an implication nothing states.
     */
    const where = inboxWhere("replies") as {
      OR: Array<Record<string, unknown>>;
    };

    expect(where.OR).toHaveLength(2);
    expect(where.OR).toContainEqual({ unreadCount: { gt: 0 } });
  });

  it("reads only the view it knows, and defaults for everything else", () => {
    expect(parseInboxView("all")).toBe("all");
    expect(parseInboxView(undefined)).toBe("replies");
    expect(parseInboxView("nonsense")).toBe("replies");
    /* A repeated query parameter arrives as an array. It must not be read as
       "all" by accident, and must not throw. */
    expect(parseInboxView(["all", "replies"])).toBe("replies");
  });
});
