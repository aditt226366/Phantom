import { describe, expect, it, vi } from "vitest";
import { fetchWhatsAppNumbers } from "../src/whatsapp/numbers.ts";
import { parseWebhookPayload } from "../src/whatsapp/payload.ts";

/**
 * Reading a company's numbers from Meta, and the webhook that says to.
 *
 * fetch is injected, so nothing here reaches the network. What is asserted is
 * the reading of Meta's answer - which fields we trust, and what happens to the
 * ones we do not recognise.
 */

const SECRETS = {
  WHATSAPP_BUSINESS_ACCOUNT_ID: "waba-1",
  WHATSAPP_ACCESS_TOKEN: "tok-secret",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reading the numbers on an account", () => {
  it("maps Meta's fields, and keeps its vocabulary verbatim", async () => {
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () =>
      jsonResponse(200, {
        data: [
          {
            id: "pn-1",
            display_phone_number: "+91 98765 43210",
            verified_name: "Alpha Ltd",
            quality_rating: "GREEN",
            messaging_limit_tier: "TIER_1K",
            throughput: { level: "STANDARD" },
            status: "CONNECTED",
          },
          {
            id: "pn-2",
            display_phone_number: "+91 90000 00000",
            quality_rating: "RED",
            /* A status this build does not model. Stored as itself. */
            status: "RATE_LIMITED",
          },
        ],
      }),
    );

    const result = await fetchWhatsAppNumbers(SECRETS, fetchImpl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.numbers).toHaveLength(2);
    expect(result.numbers[0]).toEqual({
      phoneNumberId: "pn-1",
      displayNumber: "+91 98765 43210",
      verifiedName: "Alpha Ltd",
      qualityRating: "GREEN",
      messagingTier: "TIER_1K",
      throughputLevel: "STANDARD",
      status: "CONNECTED",
    });

    expect(result.numbers[1]?.status).toBe("RATE_LIMITED");
    expect(result.numbers[1]?.verifiedName).toBeNull();
    expect(result.numbers[1]?.messagingTier).toBeNull();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("waba-1");
    expect(String(url)).not.toContain("tok-secret");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer tok-secret",
    );
  });

  it("flattens an unrecognised quality rating, unlike status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: [{ id: "pn-1", quality_rating: "CHARTREUSE", status: "BANNED" }],
      }),
    );

    const result = await fetchWhatsAppNumbers(SECRETS, fetchImpl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Opposite treatments, deliberately. Quality is a closed traffic light
     * stored as an enum, so a fifth colour is far more likely to be a shape
     * change than a real rating and the column could not hold it anyway.
     * Status is Meta's open vocabulary and is text, so it survives.
     */
    expect(result.numbers[0]?.qualityRating).toBe("UNKNOWN");
    expect(result.numbers[0]?.status).toBe("BANNED");
  });

  it("drops a row with no id rather than inventing a key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: [{ display_phone_number: "+91 1" }, { id: "pn-1" }] }),
    );

    const result = await fetchWhatsAppNumbers(SECRETS, fetchImpl);

    /* phone_number_id is the natural key; a row keyed on "" would collide with
       the next one like it. */
    expect(result.ok && result.numbers.map((n) => n.phoneNumberId)).toEqual(["pn-1"]);
  });

  it("reports an empty account as an empty list, not a failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [] }));

    const result = await fetchWhatsAppNumbers(SECRETS, fetchImpl);

    /*
     * The distinction the missing_since column depends on. An empty list is an
     * answer - every number we hold is absent from it - while a failure is not,
     * and must never be read as one.
     */
    expect(result).toEqual({ ok: true, numbers: [] });
  });

  it("does not call Meta without an account id", async () => {
    const fetchImpl = vi.fn();

    const result = await fetchWhatsAppNumbers(
      { WHATSAPP_ACCESS_TOKEN: "tok" },
      fetchImpl,
    );

    expect(result.ok === false && result.kind).toBe("config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes a refused credential through as auth", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { message: "Invalid OAuth token", code: 190 } }),
    );

    const result = await fetchWhatsAppNumbers(SECRETS, fetchImpl);

    expect(result.ok === false && result.kind).toBe("auth");
  });
});

describe("the quality webhook", () => {
  it("is parsed as a trigger, carrying what Meta said", () => {
    const parsed = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "phone_number_quality_update",
              value: {
                display_phone_number: "+91 98765 43210",
                event: "FLAGGED",
                current_limit: "TIER_1K",
              },
            },
          ],
        },
      ],
    });

    expect(parsed.qualityUpdates).toHaveLength(1);
    expect(parsed.qualityUpdates[0]).toEqual({
      kind: "quality",
      displayPhoneNumber: "+91 98765 43210",
      event: "FLAGGED",
      currentLimit: "TIER_1K",
    });

    /*
     * And not recorded as an unhandled field any more. It used to be counted as
     * skipped, which was honest at the time and would now hide a trigger that
     * fires.
     */
    expect(parsed.skipped).toEqual([]);
  });

  it("still records a field nothing handles", () => {
    /* This named message_template_status_update until 4b started handling it.
       The assertion is about the quality branch not swallowing its neighbours,
       so it needs a field nothing reads - `account_update` is one Meta really
       sends and this build really does not. */
    const parsed = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "account_update", value: {} }] }],
    });

    expect(parsed.qualityUpdates).toEqual([]);
    expect(parsed.skipped[0]?.reason).toBe("unhandled_field");
  });
});
