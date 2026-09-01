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
    expect(windowLabel({ kind: "closing", minutes: 45 })).toBe("Within the hour");
    expect(windowLabel({ kind: "closed" })).toBe("Window closed");
  });

  it("does not tick as a closing window runs down", () => {
    /*
     * The comment above always claimed a bucket and the assertion always
     * checked a minute count - which nothing caught, because no fixture had a
     * near-term window until Phase 9 seeded three and both inbox baselines
     * started moving ~190 pixels a run. Not rasteriser noise, which is one or
     * two pixels.
     *
     * So: two readings four minutes apart, inside one bucket, must render the
     * same string. An hour-scale label is coarse enough to be stable already,
     * which is why only this branch was ever a hazard.
     */
    expect(windowLabel({ kind: "closing", minutes: 45 })).toBe(
      windowLabel({ kind: "closing", minutes: 41 }),
    );
    expect(windowLabel({ kind: "closing", minutes: 12 })).toBe(
      windowLabel({ kind: "closing", minutes: 8 }),
    );
  });

  it("still separates the three decisions a deadline offers", () => {
    expect(windowLabel({ kind: "closing", minutes: 8 })).toBe("Under 15 min");
    expect(windowLabel({ kind: "closing", minutes: 22 })).toBe("Under 30 min");
    expect(windowLabel({ kind: "closing", minutes: 50 })).toBe("Within the hour");
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

  /*
   * The arm the derivation could not express. A flow's handoff node is a
   * proactive claim - the automation decided it cannot finish - and it
   * satisfies neither half above: nothing is unread, because no message
   * arrived. This is the case the whole column was added for.
   */
  it("flags a thread somebody explicitly asked for a person on", () => {
    expect(
      needsHuman({
        assignedUserId: null,
        unreadCount: 0,
        needsHumanAt: new Date("2026-09-07T09:00:00Z"),
      }),
    ).toBe(true);
  });

  it("flags it even once somebody has been assigned, until it is cleared", () => {
    /*
     * Assignment is what clears the flag, and it does so by writing the
     * column - not by being read here. If the two ever disagree, the stored
     * state is the one that is true: this function must not quietly hide a
     * request that clearNeedsHuman never ran for.
     */
    expect(
      needsHuman({
        assignedUserId: "user-1",
        unreadCount: 0,
        needsHumanAt: new Date("2026-09-07T09:00:00Z"),
      }),
    ).toBe(true);
  });

  it("reads a thread with no flag exactly as it did before", () => {
    /* The column is optional on the argument, so every existing caller that
       does not select it keeps the Phase 5 behaviour rather than silently
       becoming false. */
    expect(needsHuman({ assignedUserId: null, unreadCount: 3 })).toBe(true);
    expect(
      needsHuman({ assignedUserId: null, unreadCount: 3, needsHumanAt: null }),
    ).toBe(true);
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
  it("defaults to threads a customer has written in, or that were flagged", () => {
    expect(inboxWhere("replies")).toEqual({
      OR: [
        { lastInboundAt: { not: null } },
        { unreadCount: { gt: 0 } },
        { needsHumanAt: { not: null } },
      ],
    });
  });

  it("shows only flagged threads on the queue", () => {
    /*
     * Its own view rather than a filter on the default one, because the two
     * answer different questions. The default is "what is going on"; this is
     * "what should I pick up next", and mixing them makes the answer to the
     * second however far down the first somebody is willing to scroll.
     */
    expect(inboxWhere("attention")).toEqual({ needsHumanAt: { not: null } });
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

    expect(where.OR).toHaveLength(3);
    expect(where.OR).toContainEqual({ unreadCount: { gt: 0 } });
  });

  it("keeps a flagged thread in the default view with nothing unread", () => {
    /*
     * The clause a handoff needs. A flow that decides by itself that a person
     * is needed writes no inbound message, so lastInboundAt is untouched and
     * nothing is unread - and without this arm the thread it flagged is
     * invisible on the view most people leave open.
     */
    const where = inboxWhere("replies") as {
      OR: Array<Record<string, unknown>>;
    };

    expect(where.OR).toContainEqual({ needsHumanAt: { not: null } });
  });

  it("reads only the views it knows, and defaults for everything else", () => {
    expect(parseInboxView("all")).toBe("all");
    expect(parseInboxView("attention")).toBe("attention");
    expect(parseInboxView(undefined)).toBe("replies");
    expect(parseInboxView("nonsense")).toBe("replies");
    /* A repeated query parameter arrives as an array. It must not be read as
       "all" by accident, and must not throw. */
    expect(parseInboxView(["all", "replies"])).toBe("replies");
  });
});
