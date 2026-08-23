import { isWindowOpen, type WindowState } from "./window.ts";

/**
 * Every precondition on sending, in one place and with no I/O.
 *
 * The decision is pure: it takes facts and returns a verdict. Fetching those
 * facts is the caller's job, and that split is deliberate - it means the same
 * function answers for the composer (which wants to know before the operator
 * types) and for the worker (which must re-check immediately before the Graph
 * call, because the window can close in between).
 *
 * ---------------------------------------------------------------------------
 * The reason is a code, never a sentence
 * ---------------------------------------------------------------------------
 *
 * A refusal travels: into the failed message bubble, into the worker's logs,
 * into whatever 4b does when the template arm flips. Prose would be matched on
 * - somebody would write `if (reason.includes("window"))` and it would work
 * until the copy was reworded.
 *
 * So the reason is a closed union of machine codes, and the human sentence is
 * produced where it is displayed. Message.error_source records that a POLICY
 * refusal is ours rather than Meta's, so the two namespaces never merge.
 */

export type SendRefusal =
  /** The 24-hour window has closed. Only an approved template may go out. */
  | "window_closed"
  /** The number Meta would send from is not in a state that permits it. */
  | "number_not_sendable"
  /** Meta has told us nothing about the number yet. Fail closed. */
  | "number_status_unknown"
  /** The workspace is suspended. */
  | "company_deactivated"
  /** The contact has opted out. */
  | "contact_opted_out"
  /** Templates do not exist yet. Phase 4b removes this. */
  | "template_not_available"
  /** The template exists but Meta has not approved it. */
  | "template_not_approved";

export type SendIntent =
  | { kind: "freeform" }
  | { kind: "template"; approved: boolean };

export type SendDecision =
  | { allowed: true }
  | { allowed: false; reason: SendRefusal };

/**
 * Meta's number statuses that permit sending.
 *
 * FLAGGED is included on purpose: it means quality has dropped and Meta is
 * watching, not that messaging has stopped. Refusing on it would take a
 * customer's messaging away before Meta did.
 *
 * UNKNOWN is not included, and that has an operational consequence worth
 * stating: a number whose metadata has never been fetched cannot send. The
 * refresh job runs after a successful verification, so the ordinary path is
 * connect, verify, refresh, send. Failing closed here is the right way round -
 * sending from a number Meta may have restricted is the outcome that costs a
 * customer their account.
 */
const SENDABLE_NUMBER_STATUSES = new Set(["CONNECTED", "FLAGGED"]);

/**
 * The statuses this build has an opinion about.
 *
 * The column is text as of 20260816100000, because the vocabulary is Meta's and
 * they document more members than we model - BANNED, MIGRATED, RATE_LIMITED and
 * UNVERIFIED at least. So the interesting question is no longer "which of our
 * five is it" but "do we recognise this at all".
 *
 * A value we do not recognise is treated as UNKNOWN for the send decision:
 * refused, and refused with the reason that says we cannot vouch for the number
 * rather than one that claims to know it may not send. Both fail closed, so the
 * safety is the same either way - what differs is whether the refusal tells the
 * truth about why. UNKNOWN is deliberately absent from this set for that reason;
 * it means "Meta has told us nothing", which is not knowledge.
 */
const KNOWN_NUMBER_STATUSES = new Set([
  "CONNECTED",
  "PENDING",
  "FLAGGED",
  "RESTRICTED",
]);

export interface SendFacts {
  window: WindowState;
  /** whatsapp_numbers.status, as stored. */
  numberStatus: string;
  companyDeactivated: boolean;
  contactOptedOut: boolean;
}

/**
 * Order matters, and it is least-recoverable first.
 *
 * A suspended workspace and an opted-out contact are refusals no retry and no
 * template will fix, so they are reported ahead of the window - telling
 * somebody "the window has closed, send a template" when the contact has opted
 * out would be advice that leads to a worse outcome than doing nothing.
 */
export function sendPolicy(facts: SendFacts, intent: SendIntent): SendDecision {
  if (facts.companyDeactivated) {
    return { allowed: false, reason: "company_deactivated" };
  }

  if (facts.contactOptedOut) {
    return { allowed: false, reason: "contact_opted_out" };
  }

  if (!SENDABLE_NUMBER_STATUSES.has(facts.numberStatus)) {
    /*
     * Two refusals, and the split is about honesty rather than safety - both
     * arms decline. A status we model and know does not permit sending is
     * reported as such; anything else, including UNKNOWN and anything Meta has
     * added since this was written, is reported as not knowing.
     *
     * Getting this backwards would tell an operator "this number may not send"
     * about a value we have simply never seen, and send them looking for a
     * restriction that does not exist.
     */
    return KNOWN_NUMBER_STATUSES.has(facts.numberStatus)
      ? { allowed: false, reason: "number_not_sendable" }
      : { allowed: false, reason: "number_status_unknown" };
  }

  if (intent.kind === "template") {
    /*
     * The one arm 4b flips. Until the Template Studio exists there is nothing
     * to send, so this refuses regardless of the window - a template is the
     * only thing allowed outside it, and we have none.
     *
     * The `approved` flag is already on the intent so that flipping this is
     * deleting the first branch rather than changing a signature.
     */
    return { allowed: false, reason: "template_not_available" };
  }

  if (!isWindowOpen(facts.window)) {
    return { allowed: false, reason: "window_closed" };
  }

  return { allowed: true };
}
