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
   * REMOVED, not softened: aiHandling and leadScores.
   *
   * Both were replaced by real cards when the flow builder landed - see the
   * dashboard page. They are recorded here rather than deleted silently
   * because the reason is the rule this file exists for, seen from the other
   * side.
   *
   * aiHandling's copy said "Nothing here is automated yet, so every reply so
   * far was written by your team." That was true when it was written and
   * becomes a false statement about the tenant's own business the moment a
   * flow is published - on a page whose every other figure is true, which is
   * the worst possible place to put one. A pending card is not a placeholder
   * that can be left; it is a claim, and it expires.
   *
   * leadScores said the score came "from what a customer actually said rather
   * than from how recently they wrote". A flow's action node scores on a
   * button somebody tapped, which is a narrower and more honest claim than the
   * one that card made - so the real card says what it actually measures
   * rather than inheriting the promise.
   */

  /**
   * The funnel, and it is still pending because its last step does not exist.
   *
   * Contacts, conversations and qualified leads are all real now - a flow's
   * action node is what qualifies one. Orders are not, so a pyramid drawn
   * today would have three real tiers and a fourth that is always zero, which
   * reads as a business nobody buys from.
   *
   * The section it names has moved for the same reason: what this waits on is
   * order tracking, not the AI layer. Naming AI Messaging would have this card
   * arrive with a phase that cannot deliver it.
   */
  leadPyramid: {
    title: "From first contact to order",
    description:
      "How many contacts became conversations, conversations became qualified leads, and leads became orders. The first three are counted now; nothing yet records an order.",
    arrivesWith: null,
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
