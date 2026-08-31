import type { WindowState } from "@whatsapp-os/core/whatsapp";

/**
 * What the conversation list says about a thread.
 *
 * Every decision the list makes, as functions over plain values. The list
 * itself then has no branches worth testing, which is the point: a check that
 * the markup contains "Needs a person" would pass with the condition inverted,
 * and this repository has already shipped one assertion that stayed green after
 * the control it named was deleted.
 */

/**
 * Who the thread is with.
 *
 * displayName wins over profileName because somebody here typed it and Meta
 * did not — the schema says so on the column. The last two are fallbacks, not
 * niceties: profileName arrives only on the first inbound message of a window
 * and never reliably again, so a thread with neither name is ordinary rather
 * than broken, and it must still be addressable by the number the customer
 * messages from.
 *
 * waId last, because it is the only value guaranteed to exist. A row that
 * rendered blank here would be a thread nobody could pick out of a list.
 */
export function contactLabel(contact: {
  displayName: string | null;
  profileName: string | null;
  phoneE164: string | null;
  waId: string;
}): string {
  return (
    contact.displayName ?? contact.profileName ?? contact.phoneE164 ?? contact.waId
  );
}

/**
 * The window, as a phrase — never as a timestamp.
 *
 * C11: `windowExpiresAt` is the one value the visual fixture lets the clock
 * decide, so that the open thread stays open rather than expiring on a date
 * nobody wrote down. The price is that it may only ever be rendered through a
 * bucket coarse enough that the minutes between seeding and screenshotting
 * cannot move it. describeWindow rounds up, so "18 hours left" holds for a
 * whole hour and a run would have to take that long to change this string.
 */
export function windowLabel(state: WindowState): string {
  switch (state.kind) {
    case "closed":
      return "Window closed";
    case "closing":
      return `${state.minutes}m left`;
    case "open":
      return `${state.hours}h left`;
  }
}

/** Green for a window that is open, neutral for one that is not. */
export function windowVariant(
  state: WindowState,
): "success" | "outline" | "default" {
  if (state.kind === "closed") return "outline";
  /* Under an hour is still open and still free-form. Neutral rather than an
     error, because nothing has gone wrong — it is a deadline, not a fault. */
  return state.kind === "closing" ? "default" : "success";
}

/**
 * Whether a person is needed here, as far as this build can tell.
 *
 * There is no handover flag in the schema and this does not invent one. The AI
 * that would set it is a later phase; what exists today is the schema's own
 * notion — `assignedUserId` null means nobody has picked the thread up — and
 * the fact that the customer is waiting on a reply.
 *
 * Both halves are load-bearing. Unassigned alone would flag every thread that
 * was ever answered and closed out, which makes the signal worthless within a
 * day. Unread alone would flag threads a colleague has already taken.
 */
export function needsHuman(conversation: {
  assignedUserId: string | null;
  unreadCount: number;
}): boolean {
  return conversation.assignedUserId === null && conversation.unreadCount > 0;
}

/** How the thread started, in words rather than in the enum's. */
const SOURCE_LABELS: Record<string, string> = {
  INBOUND: "Customer wrote first",
  CAMPAIGN: "Campaign",
  ADS_CLICK_TO_WHATSAPP: "Ad click",
  MANUAL: "Started here",
};

export function sourceLabel(source: string): string {
  /* An unrecognised value renders as itself rather than as a blank. The column
     is ours and an enum, so this cannot happen today — but the fallback costs
     nothing and a silently empty cell is the hardest kind of gap to notice. */
  return SOURCE_LABELS[source] ?? source;
}

/**
 * The one-line preview.
 *
 * Null is a real state: a conversation exists from its first message, but an
 * image with no caption leaves nothing to quote. Named rather than blank, the
 * way formatTimestamp says "Never".
 */
export function previewLabel(preview: string | null): string {
  return preview ?? "No preview";
}

/* ------------------------------------------------------------------------- *
 * Which conversations the inbox shows
 * ------------------------------------------------------------------------- */

export type InboxView = "replies" | "all";

/** `?view=all` and nothing else. Anything unrecognised falls back to the default. */
export function parseInboxView(raw: string | string[] | undefined): InboxView {
  return raw === "all" ? "all" : "replies";
}

/**
 * The default inbox is threads a customer has actually written in.
 *
 * ---------------------------------------------------------------------------
 * Why the default changed
 * ---------------------------------------------------------------------------
 *
 * Bulk messaging creates a conversation per recipient, which is correct - a
 * customer who replies must land in the inbox beside everybody else, and does.
 * The consequence is that a ten thousand recipient broadcast puts ten thousand
 * one-way threads at the top of the list, and every genuine conversation is
 * buried under them.
 *
 * The model is not the problem, so the model does not change. What changes is
 * the default view: the inbox's job is conversations that need a person, and a
 * thread nobody has replied to needs nobody. "All conversations" is one click
 * away and shows exactly what it did before.
 *
 * ---------------------------------------------------------------------------
 * Why both clauses, when one currently implies the other
 * ---------------------------------------------------------------------------
 *
 * `unread_count` is only ever incremented for an inbound message, so today
 * `unreadCount > 0` implies `lastInboundAt` is set and the second clause adds
 * nothing. It is here anyway because the two facts mean different things: one
 * is "the customer has ever written", the other is "somebody here has not read
 * it yet". A thread with unread messages belongs in this view on its own
 * merits, and it should not stop appearing because a future change to how
 * `last_inbound_at` is written breaks an implication nothing states.
 *
 * A where fragment rather than an inline object, so the decision is testable
 * without rendering a page - which is the rule that has cost this repository
 * the same lesson twice.
 */
export function inboxWhere(view: InboxView): Record<string, unknown> {
  if (view === "all") return {};

  return {
    OR: [{ lastInboundAt: { not: null } }, { unreadCount: { gt: 0 } }],
  };
}
