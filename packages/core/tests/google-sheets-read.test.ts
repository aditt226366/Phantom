import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedAccessToken,
  checkSheetAccess,
  clearAccessTokenCache,
  exchangeAccessToken,
  isQuotaFailure,
  listSheetTabs,
  readSheetValues,
  retryAfterMs,
} from "../src/providers/index.ts";

/**
 * The reads a lead source runs on, and the token cache underneath them.
 *
 * Every case here is about something that fails silently in production: a
 * cached token surviving a key rotation, a phone number arriving as a float, a
 * 429 answered by retrying immediately. None of them throws, and none of them
 * shows up as anything but "the sheet never sent us anybody".
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { privateKey: rotatedKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SECRETS = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "leads@project.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: privateKey,
};

const SHEET_ID = "1A2B3C4D5E6F7G8H9I0J";
const ACCESS_TOKEN = "ya29.a0AfB_realLookingGoogleAccessToken";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenResponse(expiresIn = 3600): Response {
  return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: expiresIn });
}

/** A fetch that answers each call in order, then repeats the last. */
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

beforeEach(() => {
  clearAccessTokenCache();
});

describe("the access token", () => {
  it("exchanges a signed assertion and never puts the key on the wire", async () => {
    const { impl, calls } = stubFetch(tokenResponse());

    const outcome = await exchangeAccessToken(SECRETS, impl);

    expect(outcome.ok).toBe(true);
    const body = String(calls[0]?.init?.body);
    expect(body).toContain("grant_type=urn");
    expect(body).not.toContain("BEGIN PRIVATE KEY");
    expect(body).not.toContain(encodeURIComponent(privateKey.slice(0, 40)));
  });

  it("expires the cached token five minutes early", async () => {
    /* A token that dies mid-request presents as a 401 on a credential that is
       perfectly good, which is the one fault this cache could introduce. */
    const { impl } = stubFetch(tokenResponse(3600));

    const first = await cachedAccessToken(SECRETS, impl, 1_000_000);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.access.expiresAt).toBe(1_000_000 + 3_600_000 - 300_000);
  });

  it("reuses a live token rather than re-signing per poll", async () => {
    const { impl } = stubFetch(tokenResponse());

    await cachedAccessToken(SECRETS, impl, 0);
    await cachedAccessToken(SECRETS, impl, 60_000);
    await cachedAccessToken(SECRETS, impl, 120_000);

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("mints again once the cached token is spent", async () => {
    const { impl } = stubFetch(tokenResponse(), tokenResponse());

    await cachedAccessToken(SECRETS, impl, 0);
    await cachedAccessToken(SECRETS, impl, 3_600_000);

    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("does not serve a token minted from a rotated private key", async () => {
    /*
     * The case the fingerprint in the cache key exists for. A tenant who
     * rotates because they believe the old key leaked would otherwise keep
     * getting tokens minted from it for up to an hour, out of our cache, with
     * nothing anywhere to say so.
     */
    const { impl } = stubFetch(tokenResponse(), tokenResponse());

    await cachedAccessToken(SECRETS, impl, 0);
    await cachedAccessToken(
      { ...SECRETS, GOOGLE_PRIVATE_KEY: rotatedKey },
      impl,
      1_000,
    );

    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure", async () => {
    /* A 401 now says nothing about the credential in thirty seconds, and
       remembering it would keep the integration broken until a restart. */
    const { impl } = stubFetch(
      jsonResponse(401, { error: "invalid_grant" }),
      tokenResponse(),
    );

    const failed = await cachedAccessToken(SECRETS, impl, 0);
    const recovered = await cachedAccessToken(SECRETS, impl, 1_000);

    expect(failed.ok).toBe(false);
    expect(recovered.ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("classifies invalid_grant as auth whatever the status", async () => {
    const { impl } = stubFetch(jsonResponse(400, { error: "invalid_grant" }));

    const outcome = await exchangeAccessToken(SECRETS, impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("auth");
  });
});

describe("reading a sheet", () => {
  it("asks for the tab's whole used range, not a guessed A1:Z", async () => {
    /* An explicit column bound silently truncates a wider sheet, and the only
       symptom is a mapped column that is always empty. */
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [["Name", "Mobile"]] }),
    );

    await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(calls[1]?.url).toContain("/values/Leads");
    expect(calls[1]?.url).not.toContain("A1%3A");
  });

  it("keeps every digit of a phone number stored as a spreadsheet number", async () => {
    /*
     * The reason for UNFORMATTED_VALUE. A number typed into a sheet is a
     * number to Google, and its FORMATTED value can be "9.87654E+09" - which
     * parsePhone rejects, so the whole import silently produces zero leads.
     */
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [["Name", "Mobile"], ["Asha", 9876543210]] }),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(calls[1]?.url).toContain("valueRenderOption=UNFORMATTED_VALUE");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows[1]).toEqual(["Asha", "9876543210"]);
  });

  it("survives a ragged sheet without throwing", async () => {
    /* Google trims trailing blanks per row, so a row with an empty last cell
       comes back shorter than the header. */
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [["Name", "Mobile", "City"], ["Asha"], []] }),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toEqual([["Name", "Mobile", "City"], ["Asha"], []]);
  });

  it("escapes a tab title with a space in it", async () => {
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [] }),
    );

    await readSheetValues(SECRETS, SHEET_ID, "New leads", impl);

    expect(calls[1]?.url).toContain("/values/New%20leads");
  });

  it("lists tabs without pulling the spreadsheet's cells back", async () => {
    /* Without `fields` Google returns every cell of every sheet - the tenant's
       whole customer list, for a screen whose only question is which tab. */
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, {
        sheets: [
          { properties: { title: "Leads", sheetId: 0 } },
          { properties: { title: "Archive", sheetId: 88 } },
        ],
      }),
    );

    const outcome = await listSheetTabs(SECRETS, SHEET_ID, impl);

    expect(calls[1]?.url).toContain("fields=sheets.properties.title");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tabs).toEqual([
      { title: "Leads", sheetId: 0 },
      { title: "Archive", sheetId: 88 },
    ]);
  });

  it("sends the token as a header, never in the query string", async () => {
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [] }),
    );

    await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(calls[1]?.url).not.toContain(ACCESS_TOKEN);
    expect(
      (calls[1]?.init?.headers as Record<string, string>)["authorization"],
    ).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("carries an abort signal on the read as well as the exchange", async () => {
    const { impl, calls } = stubFetch(
      tokenResponse(),
      jsonResponse(200, { values: [] }),
    );

    await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("what a lost share looks like", () => {
  it("reports the 404 Google sends for a sheet nobody shared", async () => {
    /*
     * The single most common failure of this feature: the tenant pastes a URL
     * and never shares the sheet. Google answers 404 rather than 403, because
     * to this service account the spreadsheet genuinely does not exist.
     */
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(404, {
        error: { message: "Requested entity was not found.", status: "NOT_FOUND" },
      }),
    );

    const outcome = await checkSheetAccess(SECRETS, SHEET_ID, impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    /* config, so the badge moves. A share that was never made is not a blip
       and calling it transient would hide it for ever. */
    expect(outcome.kind).toBe("config");
    expect(outcome.error).toContain("not found");
  });

  it("reports a revoked share as auth", async () => {
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(403, {
        error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" },
      }),
    );

    const outcome = await checkSheetAccess(SECRETS, SHEET_ID, impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("auth");
  });
});

describe("quota", () => {
  it("marks a 429 as quota and honours Retry-After", async () => {
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(
        429,
        { error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
        { "retry-after": "45" },
      ),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    /* transient, so a quota blip never demotes the badge - but the poll has to
       back off, which is what these two carry. */
    expect(outcome.kind).toBe("transient");
    expect(isQuotaFailure(outcome)).toBe(true);
    expect(retryAfterMs(outcome)).toBe(45_000);
  });

  it("reports quota with no delay when Google sends no header", async () => {
    /* The caller's cue to use its own back-off rather than retry at once. */
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(429, { error: { message: "Quota exceeded" } }),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isQuotaFailure(outcome)).toBe(true);
    expect(retryAfterMs(outcome)).toBeNull();
  });

  it("ignores a Retry-After that is not a number of seconds", async () => {
    /* The HTTP-date form is legal and Google does not use it. Guessing at it
       would produce a NaN delay, which BullMQ schedules as immediately. */
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(
        429,
        { error: { message: "Quota exceeded" } },
        { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      ),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(retryAfterMs(outcome)).toBeNull();
  });

  it("does not treat an ordinary failure as a quota failure", async () => {
    const { impl } = stubFetch(
      tokenResponse(),
      jsonResponse(500, { error: { message: "Backend error" } }),
    );

    const outcome = await readSheetValues(SECRETS, SHEET_ID, "Leads", impl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(isQuotaFailure(outcome)).toBe(false);
    expect(outcome.kind).toBe("transient");
  });
});
