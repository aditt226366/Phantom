import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GRAPH_API_VERSION,
  PROVIDER_TIMEOUT_MS,
  decodeGraphFailure,
  demotesStatus,
  normalisePrivateKey,
  signServiceAccountJwt,
  verifierFor,
  verifyGoogleSheets,
  verifyMetaAds,
  verifyWhatsAppCloud,
} from "../src/providers/index.ts";

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** A private key as it survives a .env round trip. */
const ESCAPED_KEY = privateKey.replace(/\n/g, "\\n");

const SHEETS_SECRETS = {
  GOOGLE_SHEETS_ID: "1A2B3C4D5E6F7G8H9I0J",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "sheets@project.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: privateKey,
};

const WHATSAPP_SECRETS = {
  WHATSAPP_PHONE_NUMBER_ID: "109876543210987",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "220011223344556",
  WHATSAPP_ACCESS_TOKEN: TOKEN,
  WHATSAPP_VERIFY_TOKEN: "verify-token-abcdefghijkl",
};

const META_SECRETS = {
  META_ADS_ACCESS_TOKEN: TOKEN,
  META_AD_ACCOUNT_ID: "act_1234567890",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers each call in order. */
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

describe("classification", () => {
  it("demotes auth and config, never transient", () => {
    expect(demotesStatus("auth")).toBe(true);
    expect(demotesStatus("config")).toBe(true);
    expect(demotesStatus("transient")).toBe(false);
  });
});

describe("WhatsApp Cloud", () => {
  it("reports a healthy integration", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse(200, { verified_name: "Acme", display_phone_number: "+91…" }),
    );

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain(`/${GRAPH_API_VERSION}/`);
  });

  it("sends the token as a header, never in the query string", async () => {
    /* ?access_token= would put the credential in Meta's access logs, in every
       proxy between here and them, and in the URL this code reports on error. */
    const { impl, calls } = stubFetch(jsonResponse(200, {}));

    await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.url).not.toContain("access_token=");
    expect(
      (calls[0]?.init?.headers as Record<string, string>)["authorization"],
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("carries an abort signal on every call", async () => {
    const { impl, calls } = stubFetch(jsonResponse(200, {}));

    await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("demotes on a revoked token, whatever the HTTP status", async () => {
    /*
     * Meta returns code 190 with a 400 as often as a 401. Classifying on the
     * status alone leaves the badge CONNECTED through a genuinely dead
     * credential.
     */
    const { impl } = stubFetch(
      jsonResponse(400, {
        error: {
          message: "Error validating access token: Session has expired",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
          fbtrace_id: "AbCdEfGhIjK",
        },
      }),
    );

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
    expect(demotesStatus(result.kind)).toBe(true);
  });

  it("does not demote on a rate limit", async () => {
    /* Code 4 arrives as a 400. Demoting here tells every operator their
       credentials are broken because Meta throttled us. */
    const { impl } = stubFetch(
      jsonResponse(400, {
        error: { message: "Application request limit reached", code: 4 },
      }),
    );

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
    expect(demotesStatus(result.kind)).toBe(false);
  });

  it("does not demote on a 500", async () => {
    const { impl } = stubFetch(jsonResponse(503, { error: { message: "oops" } }));

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });

  it("does not demote on a timeout", async () => {
    const { impl } = stubFetch(timeoutError());

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
    expect(result.error).toContain(String(PROVIDER_TIMEOUT_MS));
  });

  it("does not demote on a reset connection", async () => {
    const { impl } = stubFetch(new Error("fetch failed: ECONNRESET"));

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });

  it("survives a gateway returning HTML instead of JSON", async () => {
    const { impl } = stubFetch(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );

    const result = await verifyWhatsAppCloud(WHATSAPP_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });
});

describe("Meta error decoding", () => {
  it("keeps the identifiers support asks for", async () => {
    const { impl } = stubFetch(
      jsonResponse(400, {
        error: {
          message: "Invalid OAuth access token",
          type: "OAuthException",
          code: 190,
          error_subcode: 460,
          fbtrace_id: "A1b2C3d4E5f",
        },
      }),
    );

    const result = await verifyMetaAds(META_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details).toEqual({
      code: 190,
      error_subcode: 460,
      fbtrace_id: "A1b2C3d4E5f",
      type: "OAuthException",
    });
  });

  it("scrubs a token Meta echoed back at us", async () => {
    /* Meta quotes request parameters in some error bodies. */
    const failure = decodeGraphFailure(
      400,
      { error: { message: `Invalid OAuth access token: ${TOKEN}`, code: 190 } },
      [TOKEN],
    );

    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.error).not.toContain(TOKEN);
    expect(failure.error).toContain("[redacted]");
  });
});

describe("Meta Ads", () => {
  it("adds the act_ prefix when it is missing", async () => {
    const { impl, calls } = stubFetch(jsonResponse(200, { name: "Acme" }));

    await verifyMetaAds({ ...META_SECRETS, META_AD_ACCOUNT_ID: "1234567890" }, impl);

    expect(calls[0]?.url).toContain("act_1234567890");
  });

  it("reports missing credentials as config, not as a provider failure", async () => {
    const { impl } = stubFetch(jsonResponse(200, {}));

    const result = await verifyMetaAds({ META_AD_ACCOUNT_ID: "act_1" }, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("config");
  });
});

describe("Google Sheets", () => {
  it("normalises a private key that lost its newlines", () => {
    expect(normalisePrivateKey(ESCAPED_KEY)).toBe(privateKey.trim());
  });

  it("strips wrapping quotes from a key copied out of JSON", () => {
    expect(normalisePrivateKey(`"${ESCAPED_KEY}"`)).toBe(privateKey.trim());
  });

  it("signs with a key in either form", () => {
    /*
     * The failure this prevents is opaque: RS256 signing on a key with literal
     * backslash-n fails inside OpenSSL with a message about DECODER routines,
     * which reads like a credential problem and is not one.
     */
    const real = signServiceAccountJwt("a@b.iam.gserviceaccount.com", privateKey, 1);
    const escaped = signServiceAccountJwt(
      "a@b.iam.gserviceaccount.com",
      ESCAPED_KEY,
      1,
    );

    expect(escaped).toBe(real);
    expect(real.split(".")).toHaveLength(3);
  });

  it("exchanges a JWT and then reads a cell", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse(200, { access_token: "ya29.token" }),
      jsonResponse(200, { values: [["hello"]] }),
    );

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("oauth2.googleapis.com");
    expect(calls[1]?.url).toContain("sheets.googleapis.com");
    expect(calls[1]?.url).toContain("/values/A1");
  });

  it("works with a key that came through an environment variable", async () => {
    const { impl } = stubFetch(
      jsonResponse(200, { access_token: "ya29.token" }),
      jsonResponse(200, {}),
    );

    const result = await verifyGoogleSheets(
      { ...SHEETS_SECRETS, GOOGLE_PRIVATE_KEY: ESCAPED_KEY },
      impl,
    );

    expect(result.ok).toBe(true);
  });

  it("treats invalid_grant as auth whatever the status", async () => {
    const { impl } = stubFetch(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Invalid JWT Signature.",
      }),
    );

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
  });

  it("does not demote when the token endpoint times out", async () => {
    const { impl } = stubFetch(timeoutError());

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });

  it("does not demote when the sheets read returns 503", async () => {
    const { impl } = stubFetch(
      jsonResponse(200, { access_token: "ya29.token" }),
      jsonResponse(503, { error: { message: "backend error" } }),
    );

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });

  it("demotes when the spreadsheet does not exist", async () => {
    /* Config: the credential works, what it points at does not. An operator
       has to fix this, so hiding it as transient would hide it forever. */
    const { impl } = stubFetch(
      jsonResponse(200, { access_token: "ya29.token" }),
      jsonResponse(404, { error: { message: "Requested entity was not found." } }),
    );

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("config");
    expect(demotesStatus(result.kind)).toBe(true);
  });

  it("reports a malformed private key as config rather than crashing", async () => {
    const { impl } = stubFetch(jsonResponse(200, {}));

    const result = await verifyGoogleSheets(
      { ...SHEETS_SECRETS, GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnope\n" },
      impl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("config");
  });

  it("never sends the private key over the network", async () => {
    /*
     * Written first as "the error message never contains the key", which was
     * asserting about something that cannot happen: Google is sent the signed
     * assertion, never the key, so it has nothing to echo. This is the claim
     * that is actually worth holding — the key stays in this process.
     */
    const { impl, calls } = stubFetch(
      jsonResponse(200, { access_token: "ya29.token" }),
      jsonResponse(200, {}),
    );

    await verifyGoogleSheets(SHEETS_SECRETS, impl);

    for (const call of calls) {
      const body = call.init?.body;
      const serialised =
        body instanceof URLSearchParams ? body.toString() : String(body ?? "");

      expect(call.url).not.toContain("PRIVATE KEY");
      expect(serialised).not.toContain("PRIVATE KEY");
      expect(serialised).not.toContain(privateKey.slice(40, 80));
    }
  });

  it("scrubs the assertion if Google quotes it back", async () => {
    /*
     * What *can* be echoed. The assertion is a bearer credential for the next
     * hour, and a 400 from the token endpoint is exactly where a request
     * parameter gets quoted.
     */
    /*
     * The stub echoes back the assertion it was actually sent. Generating one
     * in the test and hoping it matches the adapter's would depend on both
     * landing in the same wall-clock second — green most runs, red on the
     * boundary, and impossible to reproduce.
     */
    let signature = "";

    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const assertion =
        (init?.body as URLSearchParams | undefined)?.get("assertion") ?? "";
      signature = assertion.split(".")[2] ?? "";

      return jsonResponse(400, {
        error: "invalid_grant",
        error_description: `Invalid JWT: ${assertion}`,
      });
    }) as unknown as typeof fetch;

    const result = await verifyGoogleSheets(SHEETS_SECRETS, impl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(signature.length).toBeGreaterThan(40);
    /* The signature segment is the part that must not survive. */
    expect(result.error).not.toContain(signature);
  });
});

describe("the verifier registry", () => {
  it("has one for every provider", () => {
    for (const provider of ["GOOGLE_SHEETS", "WHATSAPP_CLOUD", "META_ADS"] as const) {
      expect(verifierFor(provider)).toBeTypeOf("function");
    }
  });
});
