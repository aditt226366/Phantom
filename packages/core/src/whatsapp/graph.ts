import { graphPost, type GraphResult } from "../providers/meta.ts";
import type { FetchImpl } from "../providers/types.ts";

/**
 * The WhatsApp operations, on top of the shared Graph client.
 *
 * Nothing here decodes an error or classifies a failure - meta.ts does both,
 * once. These are the request shapes and the reading of what comes back.
 */

/** 5 MiB. The cap is enforced during the download, not from content-length. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/* ==========================================================================
   Sending
   ========================================================================== */

/**
 * What Meta says when it accepts a message.
 *
 *   { contacts: [{ input, wa_id }], messages: [{ id, message_status }] }
 *
 * Two fields in there matter more than they look.
 */
interface SendResponse {
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string; message_status?: string }>;
}

/**
 * Meta accepted the message. Whether it will send it is a separate question.
 */
export interface SendAccepted {
  ok: true;
  wamid: string;

  /**
   * Meta's canonical wa_id for the recipient, which is not always the number
   * we addressed.
   *
   * This is the same Brazil and Mexico digit difference that made wa_id the
   * contact key rather than the normalised phone number. Send to one form,
   * and the customer's reply arrives under the mapped form - which would
   * create a second contact, with its own conversation and its own 24-hour
   * window, for the same person.
   *
   * So the caller reconciles this onto the contact. Null when Meta did not
   * include a contacts array, which happens for some template sends.
   */
  waId: string | null;

  /**
   * Meta's own word for what it did, verbatim.
   *
   * "accepted" is the ordinary answer. "held_for_quality_assessment" means
   * Meta has NOT sent it and may never - treating that as sent puts a bubble
   * in the thread that will never progress and never fail.
   */
  messageStatus: string;

  /** True when Meta is holding it rather than sending it. */
  held: boolean;
}

/**
 * Meta refused, and said why.
 *
 * `delivery: "refused"` is the load-bearing part. A structured error response
 * proves the message was not sent, which makes a retry safe - the send job
 * runs with attempts: 1 precisely because most failures cannot prove that.
 */
export interface SendRefused {
  ok: false;
  delivery: "refused";
  kind: "auth" | "config" | "transient";
  statusCode?: number;
  /** Already scrubbed. Safe to show the operator, and worth showing. */
  error: string;
  details?: Record<string, unknown>;
}

/**
 * No answer arrived, so nobody knows whether Meta accepted it.
 *
 * A timeout after Meta processed the request looks exactly like a timeout
 * before it did. There is no query that resolves the ambiguity - the endpoint
 * has no idempotency key and no "did this land" lookup.
 *
 * This is the case attempts: 1 exists for. An automatic retry here sends a
 * real customer the same message twice, and no retry at all leaves a message
 * that may or may not have arrived. A person decides, told plainly which of
 * the two situations they are in.
 */
export interface SendUnknown {
  ok: false;
  delivery: "unknown";
  error: string;
}

export type SendOutcome = SendAccepted | SendRefused | SendUnknown;

const HELD_STATUS = "held_for_quality_assessment";

export async function sendWhatsAppText(
  secrets: Readonly<Record<string, string>>,
  input: { to: string; body: string },
  fetchImpl: FetchImpl = fetch,
): Promise<SendOutcome> {
  const phoneNumberId = secrets["WHATSAPP_PHONE_NUMBER_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      delivery: "refused",
      kind: "config",
      error: "Phone number ID and access token are both required.",
    };
  }

  const result: GraphResult<SendResponse> = await graphPost<SendResponse>(
    `${encodeURIComponent(phoneNumberId)}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { preview_url: false, body: input.body },
    },
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  return decodeSendResult(result);
}

/**
 * One decode for every kind of send.
 *
 * Extracted when templates arrived, and shared rather than copied for the
 * reason the copy would fail: the interesting outcome here is UNCONFIRMED - a
 * transient failure with no status code, meaning Meta may or may not have
 * processed the request - and a second implementation that got that one branch
 * subtly wrong would send a real customer the same template twice. There is one
 * set of endings, so a template that times out becomes UNCONFIRMED by exactly
 * the path a text does.
 */
function decodeSendResult(result: GraphResult<SendResponse>): SendOutcome {
  if (!result.ok) {
    /*
     * A transient failure with no status code is a timeout or a socket error:
     * the request may or may not have been processed. Anything carrying a
     * status came back from Meta, which means Meta answered, which means it
     * did not send.
     */
    if (result.kind === "transient" && result.statusCode === undefined) {
      return { ok: false, delivery: "unknown", error: result.error };
    }

    return {
      ok: false,
      delivery: "refused",
      kind: result.kind,
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
      error: result.error,
      ...(result.details === undefined ? {} : { details: result.details }),
    };
  }

  const wamid = result.data.messages?.[0]?.id;

  if (!wamid) {
    /*
     * A 200 with no message id. Meta has never done this, and if it starts,
     * treating it as accepted would leave a message with no wamid that no
     * status callback can ever match.
     */
    return {
      ok: false,
      delivery: "unknown",
      error: "Meta accepted the request but returned no message id.",
    };
  }

  const messageStatus = result.data.messages?.[0]?.message_status ?? "accepted";

  return {
    ok: true,
    wamid,
    waId: result.data.contacts?.[0]?.wa_id ?? null,
    messageStatus,
    held: messageStatus === HELD_STATUS,
  };
}

/**
 * Send an approved template.
 *
 * The one thing that may go out after the 24-hour window has closed, which is
 * what makes the window survivable as a product.
 *
 * `parameters` is the SEND-time shape and is not the submission's. The stored
 * components describe the template; these fill it in for this one send. Meta
 * matches them positionally against {{1}}, {{2}} and so on, so the order here
 * is the numbering there - which is why templateVariables returns them sorted
 * and why the composer collects them in that order.
 */
export async function sendWhatsAppTemplate(
  secrets: Readonly<Record<string, string>>,
  input: { to: string; name: string; language: string; parameters: string[] },
  fetchImpl: FetchImpl = fetch,
): Promise<SendOutcome> {
  const phoneNumberId = secrets["WHATSAPP_PHONE_NUMBER_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      delivery: "refused",
      kind: "config",
      error: "Phone number ID and access token are both required.",
    };
  }

  const result: GraphResult<SendResponse> = await graphPost<SendResponse>(
    `${encodeURIComponent(phoneNumberId)}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.name,
        language: { code: input.language },
        /* Omitted entirely when there are none: Meta rejects an empty
           components array rather than ignoring it. */
        ...(input.parameters.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: input.parameters.map((text) => ({
                    type: "text",
                    text,
                  })),
                },
              ],
            }
          : {}),
      },
    },
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  return decodeSendResult(result);
}

/**
 * Tell Meta the customer's message has been seen.
 *
 * Idempotent, which is why it keeps the default retries while the send does
 * not - marking the same message read twice is not a second anything.
 */
export async function markWhatsAppRead(
  secrets: Readonly<Record<string, string>>,
  wamid: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<unknown>> {
  const phoneNumberId = secrets["WHATSAPP_PHONE_NUMBER_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  return graphPost(
    `${encodeURIComponent(phoneNumberId)}/messages`,
    { messaging_product: "whatsapp", status: "read", message_id: wamid },
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );
}
