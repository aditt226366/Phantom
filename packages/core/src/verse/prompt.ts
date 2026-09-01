import type { RetrievedChunk } from "./retrieval.ts";
import type { VerseTurn } from "./router.ts";

/**
 * What Verse is told, and what it is not allowed to be talked out of.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of rule live here and they are not equally strong
 * ---------------------------------------------------------------------------
 *
 * The prompt below asks the model for things. A prompt is a request, and a
 * customer's message is untrusted text from a stranger sitting in the same
 * context - so anything that MATTERS cannot rest on the model complying.
 *
 * The rules that are actually enforced are enforced elsewhere, in code:
 *
 *   nothing retrieved  -> the caller never reaches this file (retrieval.ts)
 *   no tools           -> the router returns text and cannot do otherwise
 *   outside the window -> the send path refuses before the Graph call
 *   escalation         -> a code decision on the reply, not a phrase in it
 *
 * What the prompt adds is quality and tone on top of guarantees that already
 * hold. Read it that way: if a rule below would be a disaster when ignored, it
 * is in the wrong place and belongs in the caller.
 *
 * ---------------------------------------------------------------------------
 * A5 is compliance, not manners
 * ---------------------------------------------------------------------------
 *
 * Since 15 January 2026 general-purpose LLM chatbots are banned on the WhatsApp
 * Business Platform; task-specific business assistants remain allowed. Verse is
 * the second kind by design, which is why the policy changed nothing about the
 * product and everything about the status of two behaviours:
 *
 *   it GENUINELY REFUSES off-topic questions, rather than answering them with
 *   a disclaimer attached;
 *
 *   it ANSWERS HONESTLY when asked whether it is a human.
 *
 * Neither may be softened to improve a demo. The realistic way this breaks is a
 * prompt edit six months from now making the assistant "more helpful" on
 * questions outside its task - which is the exact behaviour the ban describes.
 * `verse-prompt.test.ts` asserts both sentences are present, so weakening one
 * is a failing test rather than a quiet edit to a string.
 */

export interface PromptInput {
  /** The tenant's own words, verbatim. Never normalised or summarised. */
  goal: string;
  /** The business's name, so the assistant knows who it speaks for. */
  businessName: string;
  /** The passages that cleared the floor, best first. Never empty. */
  chunks: readonly RetrievedChunk[];
}

/**
 * The sentences A5 makes load-bearing. Asserted verbatim by a test.
 *
 * Extracted as constants rather than left inline so that the test asserts a
 * value rather than grepping the assembled string for a substring - the
 * distinction this repository has been caught by more than once, most recently
 * when a coverage test was satisfied by an unused import.
 */
export const A5_OFF_TOPIC_RULE =
  "If the customer asks about anything outside this business and the reference " +
  "passages, do not answer it. Say plainly that you can only help with " +
  "questions about this business, and offer to pass them to a colleague. Do " +
  "not answer the question and add a disclaimer - refuse it.";

export const A5_HONESTY_RULE =
  "If the customer asks whether you are a human, a bot, or an AI, tell them " +
  "the truth: you are an automated assistant, not a person. Never claim or " +
  "imply otherwise, and never dodge the question.";

/**
 * The guardrails, as the model reads them.
 *
 * The first is the one that would be catastrophic if it were only a request -
 * which is why it is ALSO a code path: the caller does not reach this file at
 * all when nothing cleared the floor. Stating it here as well is belt and
 * braces on the case where something was retrieved but does not actually
 * answer the question.
 */
const GROUNDING_RULES = [
  "Answer only from the reference passages below. They are the only thing you " +
    "know about this business.",
  "Never state a price, a date, or a policy that is not written in the " +
    "passages. If a customer asks for one and it is not there, say you will " +
    "check with a colleague.",
  "Do not guess, estimate, or reason from what is usually true of businesses " +
    "like this one. If the passages do not say, you do not know.",
  "Never invent an order number, a delivery date, a discount, or a refund.",
];

const HANDOFF_RULES = [
  "Hand over to a colleague for anything involving a refund, a complaint, a " +
    "legal question, or a medical question. Do not attempt these even if the " +
    "passages seem to cover them.",
  "Keep replies short enough to read on a phone. Two or three sentences is " +
    "usually right.",
  "Write in the same language the customer wrote in.",
];

/**
 * Assemble the system prompt.
 *
 * ---------------------------------------------------------------------------
 * The passages go LAST, and the customer's text is never in here at all
 * ---------------------------------------------------------------------------
 *
 * The turns carry what the customer said; this carries what the business
 * knows. Keeping them apart is not tidiness - it is what makes the system
 * prompt stable across a conversation, and a stable prefix is what a provider
 * cache can reuse.
 *
 * It also means no customer text is ever interpolated into the instruction
 * block. That does not stop prompt injection on its own - the model still
 * reads the customer's turn - but it removes the class of failure where a
 * message ends the instructions and starts new ones, which is the version that
 * needs no cleverness at all.
 *
 * The real reason injection is survivable here is that there is nothing to
 * inject into: the router has no tools and the output is text. See router.ts.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const passages = input.chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] From "${chunk.documentTitle}":\n${chunk.content}`,
    )
    .join("\n\n");

  return [
    `You are a WhatsApp assistant for ${input.businessName}.`,
    "",
    "WHAT YOU ARE FOR",
    input.goal,
    "",
    "HOW TO ANSWER",
    ...GROUNDING_RULES.map((rule) => `- ${rule}`),
    ...HANDOFF_RULES.map((rule) => `- ${rule}`),
    `- ${A5_OFF_TOPIC_RULE}`,
    `- ${A5_HONESTY_RULE}`,
    "",
    "REFERENCE PASSAGES",
    passages,
  ].join("\n");
}

/* ------------------------------------------------------------------------- *
 * Escalation
 * ------------------------------------------------------------------------- */

export type EscalationReason =
  /** Nothing retrieved cleared the similarity floor. */
  | "no_grounding"
  /** The subject is one we refuse by policy, whatever the passages say. */
  | "restricted_subject"
  /** Three turns without the conversation moving. */
  | "no_progress"
  /** The provider declined, or returned nothing usable. */
  | "model_refused";

/**
 * Turns of a conversation after which a lack of progress is a handoff.
 *
 * Three, and asserted from both sides: two turns must NOT escalate and three
 * must. A single-sided assertion passes for every value above the real one -
 * the lesson MAX_STEPS_PER_ADVANCE produced when multiplying it by a million
 * left the suite green.
 */
export const MAX_TURNS_WITHOUT_PROGRESS = 3;

/**
 * Subjects Verse does not handle, whatever the knowledge base says.
 *
 * ---------------------------------------------------------------------------
 * Matched on the CUSTOMER's message, and deliberately crude
 * ---------------------------------------------------------------------------
 *
 * This is a keyword check, and keyword checks are easy to criticise: it will
 * miss phrasings and it will fire on innocent ones. Both are acceptable in this
 * direction, because the cost of the two errors is wildly asymmetric.
 *
 * A false positive hands a conversation to a person who did not need to see it.
 * A false negative lets an automated system discuss somebody's refund, their
 * complaint, or their medication. The second is the one that ends up in a
 * regulator's inbox, so this errs heavily toward the first.
 *
 * It is not the only defence - the prompt says the same thing, and a model that
 * follows it will decline anyway. This is the half that does not depend on the
 * model having complied, which is the half that matters when the customer's
 * message is also trying to talk it out of complying.
 */
const RESTRICTED_PATTERNS: readonly RegExp[] = [
  /\brefund(s|ed|ing)?\b/i,
  /\bchargeback\b/i,
  /\bcomplain(t|ts|ing)?\b/i,
  /\bsue\b|\blawyer\b|\blegal\b|\bcourt\b|\bconsumer\s+forum\b/i,
  /\bdoctor\b|\bmedic(al|ine|ation)\b|\bprescription\b|\bdosage\b|\bsymptom/i,
  /\ballerg(y|ic|ies)\b/i,
];

export function isRestrictedSubject(message: string): boolean {
  return RESTRICTED_PATTERNS.some((pattern) => pattern.test(message));
}

export interface EscalationInput {
  /** What the customer just wrote. */
  message: string;
  /** Whether retrieval produced evidence. */
  grounded: boolean;
  /**
   * How many times Verse has already replied in this conversation without the
   * customer's question changing. The caller counts it; this decides on it.
   */
  turnsWithoutProgress: number;
}

/**
 * Whether a person is needed, decided before the model is called.
 *
 * Returns null when Verse may answer. Every non-null answer is a reason the
 * caller writes into `needs_human_reason`, so the operator picking the thread
 * up reads why rather than finding it flagged for nothing.
 *
 * The order matters and is not arbitrary. A restricted subject outranks a lack
 * of grounding, because "we will get a colleague" is the right reply to a
 * refund request whether or not the knowledge base happens to mention refunds -
 * and a knowledge base that DOES mention them would otherwise let the model
 * answer one.
 */
export function escalationBefore(
  input: EscalationInput,
): EscalationReason | null {
  if (isRestrictedSubject(input.message)) return "restricted_subject";
  if (!input.grounded) return "no_grounding";
  if (input.turnsWithoutProgress >= MAX_TURNS_WITHOUT_PROGRESS) {
    return "no_progress";
  }
  return null;
}

/**
 * What the customer reads when Verse hands over.
 *
 * One sentence per reason, and none of them apologise for being automated or
 * explain the machinery. A customer does not need to know a similarity floor
 * was not cleared; they need to know a person is coming.
 */
export function handoffMessage(reason: EscalationReason): string {
  switch (reason) {
    case "restricted_subject":
      return "That is something I would rather a colleague handled. I have passed this on and someone will reply here shortly.";
    case "no_grounding":
      return "I do not have that information, so I have passed this to a colleague. Someone will reply here shortly.";
    case "no_progress":
      return "I do not think I am helping much here. I have passed this to a colleague who will reply shortly.";
    case "model_refused":
      return "I am not able to answer that one. I have passed it to a colleague who will reply here shortly.";
  }
}

/** The operator-facing sentence, which is allowed to name the machinery. */
export function handoffReason(reason: EscalationReason): string {
  switch (reason) {
    case "restricted_subject":
      return "Verse stopped: the customer raised a refund, complaint, legal or medical question.";
    case "no_grounding":
      return "Verse stopped: nothing in the knowledge base answered this.";
    case "no_progress":
      return `Verse stopped: ${MAX_TURNS_WITHOUT_PROGRESS} turns without progress.`;
    case "model_refused":
      return "Verse stopped: the model declined to answer.";
  }
}

/** The conversation so far, oldest first, as the router takes it. */
export function turnsFrom(
  messages: readonly { inbound: boolean; body: string | null }[],
): VerseTurn[] {
  return messages
    .filter((message): message is { inbound: boolean; body: string } =>
      typeof message.body === "string" && message.body.trim().length > 0,
    )
    .map((message) => ({
      role: message.inbound ? ("customer" as const) : ("assistant" as const),
      text: message.body,
    }));
}
