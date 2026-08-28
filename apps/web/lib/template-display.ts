/**
 * What the Studio says about a template's state.
 *
 * Meta owns the vocabulary on both fields here — the status and the rejection
 * reason — and extends both without notice. So every function below renders an
 * unrecognised value as itself rather than as a blank or a guess.
 */

export type TemplateTone = "success" | "error" | "default";

/**
 * The status badge.
 *
 * APPROVED is the only good one. REJECTED, PAUSED and DISABLED are all "this
 * will not send", which is what an operator needs to know at a glance, so they
 * share the error tone even though they differ in how they got there. PENDING
 * and IN_APPEAL are waiting, which is neither.
 */
const BLOCKED = new Set(["REJECTED", "PAUSED", "DISABLED"]);

export function templateTone(status: string): TemplateTone {
  if (status === "APPROVED") return "success";
  if (BLOCKED.has(status)) return "error";
  return "default";
}

/** Whether this template can currently be sent. Approved, and nothing else. */
export function isSendable(status: string): boolean {
  return status === "APPROVED";
}

/**
 * Meta's rejection tokens, in English.
 *
 * ---------------------------------------------------------------------------
 * The token is always shown too, and never replaced
 * ---------------------------------------------------------------------------
 *
 * `INVALID_FORMAT` is what Meta's support asks for, and it is what appears in
 * Business Manager beside the same template — so a screen that showed only our
 * paraphrase would leave somebody unable to describe their own problem to the
 * people who can fix it. The explanation is an addition, not a translation.
 *
 * And the map is deliberately incomplete. An unknown token returns null and the
 * UI renders the token alone, which is the honest outcome: Meta adds reasons,
 * and inventing an explanation for one we have never seen would be worse than
 * showing the raw value.
 *
 * The submit path also writes Meta's own *sentence* into this same column when
 * a POST is refused, rather than a token. That is why the lookup is by exact
 * match and falls through — a sentence never matches, and correctly gets no
 * second sentence bolted onto it.
 */
const REJECTION_EXPLANATIONS: Record<string, string> = {
  INVALID_FORMAT:
    "The structure is not one Meta accepts — most often a variable at the very start or end of the body, or a gap in the numbering.",
  ABUSIVE_CONTENT:
    "Meta read the wording as abusive or misleading. Rewriting the body is the only route; appealing rarely changes it.",
  SCAM: "Meta read this as a scam or phishing attempt. Anything that asks for credentials or payment details reads this way.",
  PROMOTIONAL:
    "Meta read a utility or authentication template as promotional. Either soften the wording or resubmit it as MARKETING and accept the price.",
  TAG_CONTENT_MISMATCH:
    "The wording does not match the category it was filed under.",
  INCORRECT_CATEGORY:
    "Meta thinks this belongs in a different category. Resubmitting under that category is usually faster than appealing.",
};

export function rejectionExplanation(reason: string | null): string | null {
  if (!reason) return null;
  return REJECTION_EXPLANATIONS[reason] ?? null;
}

/**
 * The quota sentence.
 *
 * R8 in one string. It says "here" because that is the only claim this number
 * can support: Meta counts edits made in Business Manager and those never reach
 * our table, so what we hold is a floor. Saying "3 of 10 used" would be a
 * statement about Meta's allowance that we are not in a position to make.
 */
export function quotaLabel(used: number, limit: number): string {
  return `${used} of ${limit} edits made here`;
}

/** The caveat under it, which is the part that stops somebody trusting it. */
export const QUOTA_CAVEAT =
  "Meta also counts edits made in Business Manager, which do not appear here — so your real remaining allowance may be lower.";
