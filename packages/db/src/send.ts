import { demotesStatus, type FailureKind } from "@whatsapp-os/core";
import type { SendRefusal } from "@whatsapp-os/core/whatsapp";
import type { CompanyClient } from "./with-company.ts";

/**
 * Writing down what happened to an outbound message.
 *
 * Four endings, and the interesting one is the third:
 *
 *   accepted     Meta took it and named it. SENT, or HELD if it said so.
 *   refused      Meta answered no. FAILED, with Meta's own reason.
 *   unconfirmed  Meta never answered. UNCONFIRMED - see 20260816120000.
 *   declined     canSend refused before we called. FAILED, with our reason.
 *
 * All four write the reason onto the message row rather than only logging it,
 * because the thread is where somebody finds out. A log line explains a missing
 * bubble to whoever reads logs; the row explains it to the person who sent it.
 */

export interface SendAcceptance {
  wamid: string;
  /** True when Meta is holding it for quality assessment rather than sending. */
  held: boolean;
  /** Meta's canonical wa_id for the recipient, when it told us. */
  waId: string | null;
}

/**
 * Meta accepted the message.
 *
 * The wamid and the status are written in ONE update, which is what keeps the
 * status floor ours rather than the webhook's: by the time any callback can
 * match this wamid, the row already says SENT or HELD. Correction C7 leans on
 * that - it is why a `sent` callback lost to the race costs nothing.
 *
 * The error columns are cleared. A retry of a message that previously came back
 * unconfirmed or refused must not keep the old sentence next to a bubble that
 * has now gone through.
 */
export async function recordSendAccepted(
  db: CompanyClient,
  companyId: string,
  messageId: string,
  acceptance: SendAcceptance,
): Promise<void> {
  await db.message.update({
    where: { id: messageId },
    data: {
      wamid: acceptance.wamid,
      status: acceptance.held ? "HELD" : "SENT",
      errorSource: null,
      errorCode: null,
      errorTitle: null,
      failedAt: null,
    },
  });
}

/**
 * Meta answered, and the answer was no.
 *
 * Non-delivery is proven here, which is the whole difference from the
 * unconfirmed case: a retry cannot duplicate anything, so the thread offers one
 * plainly. Meta's own code and title are stored because they are what a support
 * conversation quotes, and error_source records that they are Meta's rather
 * than ours.
 *
 * ---------------------------------------------------------------------------
 * An auth-class refusal demotes the integration, exactly as verification does
 * ---------------------------------------------------------------------------
 *
 * A 190 or a 401 on a send means the credential is dead, and it is dead for
 * every other call too - the same fact a verification would have discovered.
 * Without this the operator's only signal is opening individual threads and
 * reading red bubbles, while the panel still says CONNECTED: a badge that is
 * confidently wrong about the one thing it exists to report.
 *
 * `demotesStatus` and the three-way classification are commit 11's, unchanged
 * and reused rather than reimplemented - only the wiring was missing. Its
 * argument applies here word for word:
 *
 *   auth and config demote; transient never does. Meta has an outage or a
 *   request runs long, and demoting on that turns a blip into every tenant
 *   retyping working credentials - burying the one genuinely revoked token in
 *   the noise. A wrong CONNECTED is a delay; a wrong NOT_CONNECTED is an
 *   operator re-entering a credential that was never broken.
 *
 * Classifying on HTTP status alone would get Meta wrong in both directions,
 * which is why the kind comes from decodeGraphFailure rather than from
 * `statusCode`: 190 arrives with a 400 as often as a 401, and the rate-limit
 * codes 4, 17 and 32 arrive as 400 as well.
 *
 * The demotion shares this transaction with the message write. They are one
 * fact about one refusal, and a gap between them is a thread showing a failure
 * beside a panel that still says the credential is good.
 */
export async function recordSendRefused(
  db: CompanyClient,
  companyId: string,
  messageId: string,
  failure: {
    code: number | null;
    title: string;
    occurredAt: Date;
    /** From decodeGraphFailure, never derived from the status code here. */
    kind: FailureKind;
    /** The integration whose credential was refused. */
    integrationId: string;
  },
): Promise<void> {
  await db.message.update({
    where: { id: messageId },
    data: {
      status: "FAILED",
      errorSource: "META",
      errorCode: failure.code,
      errorTitle: failure.title,
      failedAt: failure.occurredAt,
    },
  });

  if (!demotesStatus(failure.kind)) return;

  await db.integration.update({
    where: { id: failure.integrationId },
    data: { status: "NOT_CONNECTED", lastError: failure.title },
  });
}

/** The sentence the thread shows when nobody knows what happened. */
export const DELIVERY_UNKNOWN_TITLE =
  "Delivery unknown - Meta did not answer. Check WhatsApp before sending again; " +
  "retrying may send this message twice.";

/**
 * Meta never answered.
 *
 * UNCONFIRMED rather than PENDING, and the reason is a query rather than a
 * rendering: anything that claims work by status selects PENDING rows and sends
 * them, so a PENDING row with a marker on it is one forgotten `AND` away from
 * the duplicate send that attempts: 1 exists to prevent.
 *
 * error_source stays null on purpose. META would claim Meta refused it, which
 * it did not - it said nothing - and POLICY would claim we declined, which we
 * also did not. A populated title beside a null source is the shape that means
 * "no verdict from anybody", and it is what the thread keys its warning on.
 */
export async function recordSendUnconfirmed(
  db: CompanyClient,
  companyId: string,
  messageId: string,
): Promise<void> {
  await db.message.update({
    where: { id: messageId },
    data: {
      status: "UNCONFIRMED",
      errorSource: null,
      errorCode: null,
      errorTitle: DELIVERY_UNKNOWN_TITLE,
    },
  });
}

/**
 * We refused to send it, before calling Meta at all.
 *
 * The reason is a machine code from sendPolicy, turned into a sentence here so
 * that one refusal does not get two wordings - the composer's and the worker's.
 * error_source is POLICY, which is what keeps our reasons and Meta's in
 * separate namespaces: a support reply must never quote a Graph code Meta never
 * issued.
 */
export async function recordSendDeclined(
  db: CompanyClient,
  companyId: string,
  messageId: string,
  reason: SendRefusal,
  occurredAt: Date,
): Promise<void> {
  await db.message.update({
    where: { id: messageId },
    data: {
      status: "FAILED",
      errorSource: "POLICY",
      errorCode: null,
      errorTitle: describeRefusal(reason),
      failedAt: occurredAt,
    },
  });
}

/**
 * A refusal code as a sentence somebody can act on.
 *
 * Here rather than in the component, because the worker writes it onto the row
 * and the row is what the thread renders. Keeping the mapping in one place is
 * what stops the same refusal reading two different ways depending on which
 * path produced it.
 */
export function describeRefusal(reason: SendRefusal): string {
  switch (reason) {
    case "window_closed":
      return "The 24-hour window closed before this was sent. Only an approved template can be sent now.";
    case "number_not_sendable":
      return "The number this would send from is not in a state that permits sending.";
    case "number_status_unknown":
      return "We have no current status for the number this would send from. Refresh it and try again.";
    case "company_deactivated":
      return "This workspace is suspended, so nothing can be sent from it.";
    case "contact_opted_out":
      return "This contact has opted out of messages.";
    case "template_not_available":
      return "Templates are not available yet, and only a template can be sent outside the window.";
    case "template_not_approved":
      return "Meta has not approved this template yet.";
    case "company_not_verified":
      /*
       * Deliberately does not name which document. The person composing is
       * often not the person who files the paperwork, so "your PAN card was
       * refused" on a message bubble is an instruction the reader usually
       * cannot act on - and it puts a fragment of the company's verification
       * state on a screen that a customer-facing operator shares.
       */
      return "This workspace is not verified yet, so nothing can be sent from it. Profile > Documents has the details.";
    case "contact_undeliverable":
      return "This number cannot receive WhatsApp messages.";
    case "broadcast_cancelled":
      return "The broadcast was cancelled before this message was sent.";
  }
}
