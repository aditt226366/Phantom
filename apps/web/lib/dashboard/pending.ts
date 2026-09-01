/**
 * The cards whose data does not exist yet, and what each one says instead.
 *
 * ---------------------------------------------------------------------------
 * Why these render at all, rather than being left out
 * ---------------------------------------------------------------------------
 *
 * Because the alternative is a zero. "Orders: 0" and "Hot leads: 0" are
 * sentences a person acts on - they read as a business having no orders, not as
 * a product having no order tracking - and there is nothing on the page to tell
 * them apart. A tenant who has been messaging customers all week and sees a
 * dashboard reporting zero orders has been told something false by a page whose
 * every other figure is true, which is the worst possible place to put one.
 *
 * So each of these renders as itself: a card that says what it will hold, and
 * which part of the product brings it. It occupies the space the real card will
 * occupy, so the layout does not rearrange under people later.
 *
 * ---------------------------------------------------------------------------
 * Why they name a section and not a phase number
 * ---------------------------------------------------------------------------
 *
 * docs/plans/spec-amendments.md is explicit that the phase numbers need one
 * deliberate renumbering pass - three phases changed size and two changed
 * position - and that every "Phase N" reference moves with it. A number written
 * into user-facing copy would be wrong on the day that pass happens and would
 * be the last place anybody looked.
 *
 * The section names are stable: they are in NAV_SECTIONS, they are what the
 * tenant already sees in the sidebar, and A1/A2/A3 are the amendments that
 * define them. Where no section owns a capability yet - orders - the copy says
 * so plainly rather than inventing an owner.
 */

export interface PendingCard {
  title: string;
  /** What the card will show, in the tenant's terms rather than ours. */
  description: string;
  /**
   * Which part of the product brings it, or null when nothing does yet.
   *
   * Null is a real member and not a placeholder. "This is not built" is honest;
   * naming a section that has not been designed to carry it would be a promise
   * made by a dashboard.
   */
  arrivesWith: string | null;
}

export const PENDING: Record<string, PendingCard> = {
  /**
   * The AI-vs-human split.
   *
   * Nothing in the schema records an AI handling a conversation, because
   * nothing does. conversations.assigned_user_id says which PERSON picked a
   * thread up, and reading "unassigned" as "handled by AI" would be the exact
   * false number this file exists to avoid - every untouched thread would count
   * as an AI success.
   */
  aiHandling: {
    title: "Who is handling chats",
    description:
      "The split between conversations Verse answered and ones a person took over. Nothing here is automated yet, so every reply so far was written by your team.",
    arrivesWith: "AI Messaging",
  },

  /**
   * Lead scoring - the hot/warm/cold split and the pyramid.
   *
   * One entry for both, because they are two renderings of one absent column.
   * Splitting them would put two different sentences in front of the same gap.
   */
  leadScores: {
    title: "Lead temperature",
    description:
      "Hot, warm and cold, scored from what a customer actually said rather than from how recently they wrote.",
    arrivesWith: "AI Messaging",
  },

  leadPyramid: {
    title: "From first contact to order",
    description:
      "How many contacts became conversations, conversations became qualified leads, and leads became orders.",
    arrivesWith: "AI Messaging",
  },

  /**
   * Orders.
   *
   * Meta's message vocabulary already includes an `order` type and the messages
   * table stores it as itself - so an order message can arrive today and be
   * shown in a thread. What does not exist is anything that reads one: no
   * order table, no value, no status. Counting `type = 'order'` messages would
   * be a number that looks like revenue and is a count of notifications.
   */
  orders: {
    title: "Orders",
    description:
      "Orders placed through WhatsApp, with their value and status. WhatsApp can already deliver an order message into your inbox; nothing yet reads one as an order.",
    arrivesWith: null,
  },
};
