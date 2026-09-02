import type { ModelRouter, VerseTurn } from "./router.ts";

/**
 * How warm this customer is, decided from what they actually said.
 *
 * ---------------------------------------------------------------------------
 * Always on the cheapest tier, whatever the campaign chose
 * ---------------------------------------------------------------------------
 *
 * Scoring runs on every inbound message of every campaign, which makes it by
 * VOLUME the most frequently called thing in this phase while being the least
 * valuable per call. A tenant picking V1 for their answers is picking it for
 * the answers; nothing about that choice says a frontier model should decide
 * HOT/WARM/COLD on a one-line message.
 *
 * So the tier is VERSE_SCORING_TIER and the caller passes the router built
 * from it - not the campaign's. That is a constant rather than a "use the
 * cheaper of the two" rule, because the second reads as a courtesy and becomes
 * wrong silently the moment the tiers are repriced.
 *
 * ---------------------------------------------------------------------------
 * NULL is not COLD
 * ---------------------------------------------------------------------------
 *
 * A score that could not be produced - the model declined, the call failed, the
 * customer has said nothing yet - is absent, never COLD. The schema comment on
 * contacts.lead_score already says so: a report counting unscored contacts as
 * cold would tell a business its entire contact book was uninterested.
 */

export type LeadScore = "HOT" | "WARM" | "COLD";

const SCORING_PROMPT = [
  "You classify how close a customer is to buying, from their messages alone.",
  "",
  "Answer with exactly one word:",
  "",
  "  HOT   — asking about price, availability, delivery of a specific item,",
  "          or saying they want to order",
  "  WARM  — engaged and asking general questions, but not about a purchase",
  "  COLD  — not interested, complaining, or asking about something unrelated",
  "",
  "Answer with the single word and nothing else. If you cannot tell, answer WARM.",
].join("\n");

/**
 * Parse the model's answer into a score, or nothing.
 *
 * Total and deliberately strict. A model that returns a sentence, a
 * justification, or a word we do not recognise produces NULL rather than a
 * guess - the failure of a cheap classifier must not become a fact written
 * against a contact, because nothing downstream would ever revisit it.
 *
 * Matched case-insensitively on the whole trimmed answer, not with `includes`.
 * "I would not say this is HOT" contains the word and means the opposite.
 */
export function parseLeadScore(text: string): LeadScore | null {
  const answer = text.trim().toUpperCase().replace(/[^A-Z]/g, "");

  if (answer === "HOT") return "HOT";
  if (answer === "WARM") return "WARM";
  if (answer === "COLD") return "COLD";

  return null;
}

/**
 * Score a conversation from its customer turns.
 *
 * Only the customer's words are sent. What the business said is not evidence
 * about how interested the customer is, and including it doubles the prompt
 * for every message of every campaign - which is the cost that matters here
 * more than anywhere else in the phase.
 */
export async function scoreConversation(
  router: ModelRouter,
  turns: readonly VerseTurn[],
): Promise<LeadScore | null> {
  const customer = turns.filter((turn) => turn.role === "customer");

  if (customer.length === 0) return null;

  const outcome = await router.complete({
    system: SCORING_PROMPT,
    turns: customer,
    /*
     * One word. A ceiling this low is also a cost control: the classifier
     * cannot run away into a paragraph of reasoning nobody reads and everybody
     * pays for.
     */
    maxOutputTokens: 8,
  });

  if (outcome.kind !== "answered") return null;

  return parseLeadScore(outcome.text);
}
