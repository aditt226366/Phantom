/**
 * How a WhatsApp number's Meta-reported state is presented.
 *
 * Extracted from the page rather than written inline, because a badge choice is
 * a decision with branches and this repository has already learned that
 * asserting a rendered substring is not a test of one — a check that the markup
 * contains "Reactivate" stayed green after the control was deleted, because the
 * word survived in a neighbouring heading. These are two functions with a
 * handful of inputs each, and the test asserts the returned value.
 */

/** The badge variants this module chooses between. Badge has no warning tier. */
export type StatusVariant = "success" | "error" | "default";

/**
 * Statuses we both model and know are bad.
 *
 * Deliberately short. Meta owns this vocabulary and extends it without notice —
 * `status` is text and not an enum for that reason (20260816100000) — so the
 * rule is: a small known-bad set reads as an error, and everything else reads
 * as neutral. Anything Meta ships after this build lands in the neutral branch
 * and still renders its own name, which is the honest answer. Colouring an
 * unrecognised value red would be claiming knowledge we do not have, and
 * colouring it green would be worse.
 */
const KNOWN_BAD_STATUSES = new Set(["FLAGGED", "RESTRICTED", "BANNED"]);

export function statusVariant(status: string): StatusVariant {
  if (status === "CONNECTED") return "success";
  if (KNOWN_BAD_STATUSES.has(status)) return "error";
  return "default";
}

/**
 * The quality traffic light.
 *
 * YELLOW is neutral, not amber: there is no warning token in globals.css and
 * inventing one here would be a literal outside that file. The word YELLOW
 * carries it, which is what the rating is anyway.
 */
export function qualityVariant(rating: string): StatusVariant {
  if (rating === "GREEN") return "success";
  if (rating === "RED") return "error";
  return "default";
}

/**
 * The URL a tenant pastes into Meta.
 *
 * `APP_URL` is validated as a URL and nothing forbids a trailing slash, so the
 * join is done here once rather than by concatenation at the call site — a
 * doubled slash produces a path Next does not route and a webhook that silently
 * never arrives, which is a long way to travel from one character.
 */
export function webhookUrl(appUrl: string, webhookKey: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/whatsapp/${webhookKey}`;
}
