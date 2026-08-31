import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppText } from "../src/whatsapp/graph.ts";
import { conversationUsageKind, findPrice, ACTIVE_PRICE_VERSION } from "../src/usage.ts";

const SECRETS = {
  WHATSAPP_PHONE_NUMBER_ID: "PN1",
  WHATSAPP_ACCESS_TOKEN: "EAAtoken-value-that-is-long-enough",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const next = responses[index++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next!;
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

const ACCEPTED = {
  messaging_product: "whatsapp",
  contacts: [{ input: "919876543210", wa_id: "919876543210" }],
  messages: [{ id: "wamid.SENT", message_status: "accepted" }],
};

describe("a message Meta accepts", () => {
  it("returns the wamid", async () => {
    const { impl } = stubFetch(jsonResponse(200, ACCEPTED));
    const result = await sendWhatsAppText(SECRETS, { to: "919876543210", body: "hi" }, impl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wamid).toBe("wamid.SENT");
    expect(result.held).toBe(false);
  });

  it("sends the token in a header, never the query string", async () => {
    const { impl, calls } = stubFetch(jsonResponse(200, ACCEPTED));
    await sendWhatsAppText(SECRETS, { to: "919876543210", body: "hi" }, impl);

    expect(calls[0]?.url).not.toContain("EAAtoken");
    expect(
      (calls[0]?.init?.headers as Record<string, string>)["authorization"],
    ).toBe("Bearer EAAtoken-value-that-is-long-enough");
    expect(calls[0]?.init?.signal).toBeDefined();
  });

  it("reports the wa_id Meta canonicalised the recipient to", async () => {
    /*
     * The reason wa_id is the contact key rather than the normalised number.
     * Brazil and Mexico have historically returned a wa_id differing by a digit
     * from the number addressed - and the customer's reply then arrives under
     * the mapped form. Without reconciling this, that reply creates a SECOND
     * contact, with its own conversation and its own 24-hour window, for the
     * same person.
     */
    const { impl } = stubFetch(
      jsonResponse(200, {
        contacts: [{ input: "5215512345678", wa_id: "525512345678" }],
        messages: [{ id: "wamid.MX", message_status: "accepted" }],
      }),
    );

    const result = await sendWhatsAppText(SECRETS, { to: "5215512345678", body: "hola" }, impl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waId).toBe("525512345678");
    expect(result.waId).not.toBe("5215512345678");
  });

  it("leaves wa_id null when Meta sends no contacts array", async () => {
    const { impl } = stubFetch(
      jsonResponse(200, { messages: [{ id: "wamid.X", message_status: "accepted" }] }),
    );
    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waId).toBeNull();
  });
});

describe("a message Meta is holding", () => {
  it("is not reported as sent", async () => {
    /*
     * held_for_quality_assessment means Meta has NOT sent it and may never.
     * Treating it as accepted puts a bubble in the thread that will never
     * progress and never fail - the worst kind of wrong, because nothing ever
     * prompts anyone to look at it.
     */
    const { impl } = stubFetch(
      jsonResponse(200, {
        contacts: [{ input: "1", wa_id: "1" }],
        messages: [{ id: "wamid.HELD", message_status: "held_for_quality_assessment" }],
      }),
    );

    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.held).toBe(true);
    expect(result.messageStatus).toBe("held_for_quality_assessment");
    expect(result.wamid).toBe("wamid.HELD");
  });

  it("keeps Meta's own word for any status it invents later", async () => {
    const { impl } = stubFetch(
      jsonResponse(200, { messages: [{ id: "w", message_status: "some_new_state" }] }),
    );
    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messageStatus).toBe("some_new_state");
    expect(result.held).toBe(false);
  });
});

describe("refused versus unknown, which is the whole reason for attempts: 1", () => {
  it("calls a structured error a refusal, which proves non-delivery", async () => {
    /*
     * Meta answered. That means it did not send. A retry is therefore safe,
     * and the failed bubble can offer one with Meta's own reason attached
     * rather than a generic failure the operator has to guess about.
     */
    const { impl } = stubFetch(
      jsonResponse(400, {
        error: {
          message: "(#131030) Recipient phone number not in allowed list",
          code: 131030,
          fbtrace_id: "AxB",
        },
      }),
    );

    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.delivery).toBe("refused");
    if (result.delivery !== "refused") return;
    expect(result.error).toContain("131030");
    expect(result.details?.["fbtrace_id"]).toBe("AxB");
  });

  it("calls a timeout unknown, because nobody can say whether it landed", async () => {
    /*
     * A timeout after Meta processed the request is indistinguishable from one
     * before it did, and there is no lookup that resolves it. This is the case
     * an automatic retry would turn into two messages to a real customer.
     */
    const { impl } = stubFetch(timeoutError());

    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.delivery).toBe("unknown");
  });

  it("calls a 200 with no message id unknown rather than accepted", async () => {
    /* Meta has never done this. If it starts, a message with no wamid can
       never be matched by a status callback, so it must not read as sent. */
    const { impl } = stubFetch(jsonResponse(200, { contacts: [] }));

    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.delivery).toBe("unknown");
  });

  it("treats a 500 as refused, since Meta still answered", async () => {
    const { impl } = stubFetch(jsonResponse(500, { error: { message: "oops" } }));
    const result = await sendWhatsAppText(SECRETS, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.delivery).toBe("refused");
  });

  it("refuses without credentials before making a call", async () => {
    const { impl, calls } = stubFetch(jsonResponse(200, ACCEPTED));
    const result = await sendWhatsAppText({}, { to: "1", body: "hi" }, impl);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("pricing records facts rather than modelling Meta", () => {
  it("prices every conversation category at the active version", () => {
    for (const category of ["marketing", "utility", "authentication", "service"]) {
      const kind = conversationUsageKind(category);
      expect(kind, category).not.toBeNull();
      expect(findPrice(kind!, ACTIVE_PRICE_VERSION), category).toBeDefined();
    }
  });

  it("does not invent a kind for a category Meta adds later", () => {
    /* An unknown category must be unpriced and visible as such, not silently
       folded into the nearest one. */
    expect(conversationUsageKind("referral_conversion")).toBeNull();
  });

  it("keeps the WhatsApp prices at zero on purpose", () => {
    /*
     * Not a placeholder. Meta's per-message pricing has changed twice recently,
     * varies by country, and is reconciled against an invoice we have no API
     * for until Phase 11. A table with plausible numbers would silently
     * disagree with what the customer is charged, and a billing figure that is
     * quietly wrong is worse than one that is openly an estimate.
     */
    for (const kind of [
      "whatsapp.message.sent",
      "whatsapp.conversation.marketing",
    ] as const) {
      expect(findPrice(kind, ACTIVE_PRICE_VERSION)?.micros, kind).toBe(0);
    }
  });
});
