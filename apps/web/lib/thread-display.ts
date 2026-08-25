import type { SendRefusal } from "@whatsapp-os/core/whatsapp";

/**
 * What a thread says about one message.
 *
 * The delivery ladder is rendered from the stored status and nothing else. It
 * is never guessed at optimistically on the client: an operator acts on these
 * words, and a bubble claiming DELIVERED because the browser assumed so is
 * worse than one that takes a moment to say Sending.
 */

export type StatusTone = "muted" | "success" | "error" | "warning";

export interface StatusDisplay {
  label: string;
  tone: StatusTone;
  /** The sentence under the bubble, where the label alone would mislead. */
  detail?: string;
}

/**
 * The ladder, in words.
 *
 * Two members carry a `detail` because their one-word label is actively
 * misleading without it, and both are outcomes a person has to act on:
 *
 *   HELD         Meta took the message, named it, and then did not send it.
 *                "Held" without the reason reads like a queue position.
 *   UNCONFIRMED  Meta never answered, so nobody knows whether the customer
 *                got it. See 20260816120000 - the whole reason this status
 *                exists rather than PENDING plus a marker.
 */
export function statusDisplay(status: string): StatusDisplay {
  switch (status) {
    case "PENDING":
      return { label: "Sending", tone: "muted" };
    case "UNCONFIRMED":
      return {
        label: "Delivery unknown",
        tone: "warning",
        detail:
          "Meta never answered, so this may or may not have arrived. Check WhatsApp before sending it again — retrying may deliver it twice.",
      };
    case "HELD":
      return {
        label: "Held by Meta",
        tone: "warning",
        detail:
          "Meta accepted this message and is holding it for quality assessment rather than sending it.",
      };
    case "SENT":
      return { label: "Sent", tone: "muted" };
    case "DELIVERED":
      return { label: "Delivered", tone: "muted" };
    case "READ":
      return { label: "Read", tone: "success" };
    case "FAILED":
      return { label: "Failed", tone: "error" };
    default:
      /* The column is our enum, so this is unreachable today. It renders the
         value rather than a blank, because a bubble with no status at all is
         the hardest kind of gap to notice. */
      return { label: status, tone: "muted" };
  }
}

/**
 * Why the composer is closed, in a sentence somebody can act on.
 *
 * send-policy.ts deliberately returns machine codes and says the human sentence
 * belongs where it is displayed - that is here. Each of these tells the reader
 * what to do next, because a refusal that only names itself sends them to
 * support.
 */
const REFUSAL_SENTENCES: Record<SendRefusal, string> = {
  window_closed:
    "More than 24 hours have passed since this customer last wrote, so WhatsApp only allows an approved template.",
  number_not_sendable:
    "Meta has put this number in a state that does not allow sending. Check it in Business Manager.",
  number_status_unknown:
    "Meta has not told us what state this number is in, so nothing is sent from it. It refreshes after the next successful connection test.",
  company_deactivated: "This workspace is suspended, so nothing is sent from it.",
  contact_opted_out:
    "This contact has opted out, so nothing further is sent to them.",
  template_not_available: "Templates arrive in the next release.",
  template_not_approved: "Meta has not approved this template yet.",
};

export function refusalSentence(reason: SendRefusal): string {
  return REFUSAL_SENTENCES[reason];
}
