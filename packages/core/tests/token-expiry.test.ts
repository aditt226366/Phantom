import { describe, expect, it, vi } from "vitest";
import { effectiveIntegrationStatus } from "../src/integrations.ts";
import {
  TOKEN_EXPIRY_WARNING_DAYS,
  debugToken,
  expiryDemotesStatus,
  tokenExpiryState,
} from "../src/providers/token.ts";

/**
 * The half of A3 that is not the credential itself: knowing when it stops
 * working, and what the console does about it.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

describe("the state of a stored expiry", () => {
  it("calls a credential with no expiry what it is", () => {
    /*
     * `no_expiry` is its own member rather than being folded into `healthy`.
     * A Google private key and a token expiring in a year are different facts,
     * and only the second wants a date rendered beside it. Collapsed together,
     * the panel prints "expires never" or nothing, and neither is the answer.
     */
    expect(tokenExpiryState(null, NOW)).toBe("no_expiry");
    expect(tokenExpiryState(undefined, NOW)).toBe("no_expiry");
  });

  it("is healthy well before the warning window", () => {
    expect(tokenExpiryState(inDays(60), NOW)).toBe("healthy");
  });

  it("is expiring inside the warning window", () => {
    expect(tokenExpiryState(inDays(3), NOW)).toBe("expiring");
  });

  it("brackets the warning window from both sides", () => {
    /*
     * A constant that is a guard gets asserted from both sides. A single
     * assertion inside the window passes for any threshold at all, including
     * one that warns a year early.
     */
    expect(tokenExpiryState(inDays(TOKEN_EXPIRY_WARNING_DAYS - 0.01), NOW)).toBe("expiring");
    expect(tokenExpiryState(inDays(TOKEN_EXPIRY_WARNING_DAYS + 0.01), NOW)).toBe("healthy");
  });

  it("is expired at the instant it lapses, not a moment after", () => {
    expect(tokenExpiryState(NOW, NOW)).toBe("expired");
    expect(tokenExpiryState(inDays(-1), NOW)).toBe("expired");
  });
});

describe("what moves the badge", () => {
  it("demotes only once the token has actually lapsed", () => {
    /*
     * The line is at expired, not expiring, and this is the assertion that
     * holds it there. An expiring token still works; the documented operator
     * response to NOT_CONNECTED is to re-enter credentials, so demoting a week
     * early would produce a week of people retyping working secrets. The
     * banner says "act soon"; the badge says "it does not work now".
     */
    expect(expiryDemotesStatus("expired")).toBe(true);
    expect(expiryDemotesStatus("expiring")).toBe(false);
    expect(expiryDemotesStatus("healthy")).toBe(false);
    expect(expiryDemotesStatus("no_expiry")).toBe(false);
  });

  it("takes a Meta Ads integration to NOT_CONNECTED when its token has lapsed", () => {
    const all = ["META_ADS_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"];

    expect(effectiveIntegrationStatus("META_ADS", all, "CONNECTED", false)).toBe(
      "CONNECTED",
    );
    expect(effectiveIntegrationStatus("META_ADS", all, "CONNECTED", true)).toBe(
      "NOT_CONNECTED",
    );
  });

  it("leaves every existing caller unchanged", () => {
    /* The parameter defaults to false, so the two providers with no expiring
       credential - and every call site written before this phase - keep the
       behaviour they had. */
    expect(
      effectiveIntegrationStatus(
        "WHATSAPP_CLOUD",
        [
          "WHATSAPP_PHONE_NUMBER_ID",
          "WHATSAPP_BUSINESS_ACCOUNT_ID",
          "WHATSAPP_ACCESS_TOKEN",
          "WHATSAPP_VERIFY_TOKEN",
          "WHATSAPP_APP_SECRET",
        ],
        "CONNECTED",
      ),
    ).toBe("CONNECTED");
  });
});

describe("asking Meta when a token expires", () => {
  function stub(body: unknown, status = 200) {
    const calls: string[] = [];
    const impl = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("reads Unix seconds as an instant", async () => {
    const { impl } = stub({ data: { expires_at: 1789000000, is_valid: true } });

    const result = await debugToken("tok", impl);

    expect(result.ok && result.data.expiresAt?.toISOString()).toBe(
      new Date(1789000000 * 1000).toISOString(),
    );
  });

  it("reads Meta's zero as no expiry rather than 1970", async () => {
    /*
     * A long-lived system user token reports expires_at: 0, which is what a
     * well-configured tenant will have. Passed through as an instant it would
     * render as an integration that expired during the Nixon administration,
     * and demote a credential that never lapses.
     */
    const { impl } = stub({ data: { expires_at: 0, is_valid: true } });

    const result = await debugToken("tok", impl);

    expect(result.ok && result.data.expiresAt).toBeNull();
    expect(tokenExpiryState(result.ok ? result.data.expiresAt : null, NOW)).toBe(
      "no_expiry",
    );
  });

  it("inspects the token with itself, holding no app credential", async () => {
    /*
     * A3 in one assertion. The documented caller for debug_token is an app
     * access token - which is exactly the cross-tenant credential this
     * amendment removed. The only secret in this request is the tenant's own.
     */
    const { impl, calls } = stub({ data: { expires_at: 0 } });

    await debugToken("tenant-token", impl);

    expect(calls[0]).toContain("input_token=tenant-token");
  });

  it("carries a refusal through as an auth failure", async () => {
    const { impl } = stub({ error: { message: "Invalid OAuth token", code: 190 } }, 400);

    const result = await debugToken("tok", impl);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("auth");
  });
});
