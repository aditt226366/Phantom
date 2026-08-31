import { createHash, createSign } from "node:crypto";
import { scrubText } from "../redact.ts";
import {
  PROVIDER_TIMEOUT_MS,
  classifyStatus,
  type FetchImpl,
  type VerificationFailure,
  type VerificationOutcome,
} from "./types.ts";

/**
 * Google Sheets, over REST.
 *
 * ---------------------------------------------------------------------------
 * Why not googleapis
 * ---------------------------------------------------------------------------
 *
 * The official client manages its own transport. That removes the seam every
 * adapter here is built on — an injected fetch, so a test can answer with a
 * 401 or a timeout without a network — and it costs an order of magnitude more
 * dependency than a handful of HTTP calls need. Every hop below goes through
 * fetchImpl, which is the entire reason this layer is testable.
 *
 * Two hops for a verification: exchange a signed JWT for an access token, then
 * read one cell. The read is the part worth doing. A token exchange only
 * proves the service account exists; fetching A1 proves this spreadsheet is
 * real and shared with it, which is the thing that is actually wrong when a
 * customer says the integration is broken.
 *
 * ---------------------------------------------------------------------------
 * The scope is read-only, and stays read-only however the sheet is shared
 * ---------------------------------------------------------------------------
 *
 * A lead source asks the tenant to share their sheet with the service account
 * as Editor, because that is what Google's own share dialog and the Apps
 * Script path need. This scope is `spreadsheets.readonly` regardless, so the
 * extra permission is one we are structurally unable to exercise: a token
 * minted here cannot write a cell even to a sheet that would allow it.
 *
 * That is worth keeping. A tenant hands over a spreadsheet full of their
 * customers, and "we only ever read it" should be a property of the credential
 * rather than a promise about our code.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * Repair a private key that has been through an environment variable.
 *
 * A PEM block is newline-delimited, and every path that carries one as a
 * single line turns those newlines into a literal backslash and an n — pasting
 * into a form field, storing in .env, round-tripping through JSON. The signer
 * then fails with something about DECODER routines, which says nothing about
 * the actual problem.
 *
 * Quotes get stripped for the same reason: a value copied out of a JSON key
 * file arrives wrapped in them.
 */
export function normalisePrivateKey(key: string): string {
  return key
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .trim();
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A service-account assertion, signed RS256 with node:crypto.
 *
 * Exported for its own test: a signature is either right or opaque, and the
 * failure mode of getting it wrong is a 400 from Google that reads like a
 * credential problem.
 */
export function signServiceAccountJwt(
  clientEmail: string,
  privateKey: string,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();

  return `${header}.${claims}.${signer.sign(normalisePrivateKey(privateKey), "base64url")}`;
}

/* ------------------------------------------------------------------------- *
 * The access token
 * ------------------------------------------------------------------------- */

/** A minted token and the instant it stops being usable. */
export interface GoogleAccessToken {
  token: string;
  /** Epoch milliseconds, already reduced by the skew below. */
  expiresAt: number;
}

export type AccessTokenOutcome =
  | { ok: true; access: GoogleAccessToken }
  | VerificationFailure;

/**
 * How early a cached token is treated as spent.
 *
 * Google issues them for an hour. Five minutes of margin covers a poll that
 * starts just inside the window and a Sheets read that then takes its full ten
 * seconds, plus whatever clock skew exists between this process and Google's.
 * A token that expires mid-request presents as a 401 on a credential that is
 * perfectly good, which is the one failure this cache could introduce.
 */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/**
 * Tokens held between polls, keyed by the credential that minted them.
 *
 * A binding polling every 30 seconds re-signs an RS256 assertion and makes a
 * network round trip 120 times an hour for a token that was valid the whole
 * time. At a hundred bindings that is twelve thousand pointless exchanges an
 * hour, and the RSA signing alone is real CPU in a process whose job is to
 * read a spreadsheet.
 *
 * ---------------------------------------------------------------------------
 * Why the key includes a fingerprint of the private key
 * ---------------------------------------------------------------------------
 *
 * Keying on the service account email alone would survive a key rotation, and
 * that is exactly the case that must not survive it. A tenant who rotates
 * because they believe the old key leaked would keep getting tokens minted
 * from it for up to an hour — from our cache, with nothing to say so. The
 * fingerprint makes a rotated key a different cache entry, so the next poll
 * mints from the new one.
 *
 * A SHA-256 prefix rather than the key itself: the key is already in memory,
 * but a Map keyed by PEM blocks is one accidental log line away from printing
 * them.
 */
const tokenCache = new Map<string, GoogleAccessToken>();

function cacheKey(clientEmail: string, privateKey: string): string {
  const fingerprint = createHash("sha256")
    .update(normalisePrivateKey(privateKey))
    .digest("hex")
    .slice(0, 16);

  return `${clientEmail}:${fingerprint}`;
}

/**
 * Forget every cached token.
 *
 * For tests, which would otherwise leak a token from one case into the next
 * and see a fetch that never happened. Nothing in the product calls it: a
 * credential change already produces a different cache key.
 */
export function clearAccessTokenCache(): void {
  tokenCache.clear();
}

/**
 * Mint a fresh access token. No cache, in either direction.
 *
 * This is what a verification uses. "Test connection" that answered from a
 * cache would report on a credential the provider was last asked about fifty
 * minutes ago — which is precisely the question the operator is pressing the
 * button to settle.
 */
export async function exchangeAccessToken(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<AccessTokenOutcome> {
  const clientEmail = secrets["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const privateKey = secrets["GOOGLE_PRIVATE_KEY"] ?? "";
  const values = Object.values(secrets);

  if (!clientEmail || !privateKey) {
    return {
      ok: false,
      kind: "config",
      error: "A service account email and private key are both required.",
    };
  }

  let assertion: string;
  try {
    assertion = signServiceAccountJwt(
      clientEmail,
      privateKey,
      Math.floor(now / 1000),
    );
  } catch (cause) {
    /* A malformed key is the operator's problem, not a blip. */
    return {
      ok: false,
      kind: "config",
      error: scrubText(
        `The private key could not be used to sign a request: ${describe(cause)}`,
        values,
      ),
    };
  }

  try {
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    const body = (await safeJson(response)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok) {
      /*
       * invalid_grant is Google for "this service account cannot authenticate"
       * — revoked, deleted, or clock-skewed. Auth, whatever the HTTP status.
       */
      const kind =
        body.error === "invalid_grant" ? "auth" : classifyStatus(response.status);

      return {
        ok: false,
        kind,
        statusCode: response.status,
        error: scrubText(
          body.error_description ?? body.error ?? "Token exchange failed.",
          /*
           * The assertion is in the scrub list as well as the stored secrets.
           * Google never sees the private key — it receives this JWT — so the
           * assertion is the credential actually at risk of being quoted back,
           * and it is a bearer token for the next hour.
           */
          [...values, assertion],
        ),
        ...failureDetails(response, body.error),
      };
    }

    if (!body.access_token) {
      return {
        ok: false,
        kind: "transient",
        statusCode: response.status,
        error: "Google returned no access token.",
      };
    }

    /*
     * expires_in is trusted when present and floored at an hour when it is
     * not. Google has always sent 3599 here; assuming a longer life than it
     * granted would produce 401s on a credential that is fine.
     */
    const lifetimeMs = (body.expires_in ?? 3600) * 1000;

    return {
      ok: true,
      access: {
        token: body.access_token,
        expiresAt: now + Math.max(lifetimeMs - TOKEN_SKEW_MS, 0),
      },
    };
  } catch (cause) {
    return transient(cause, values);
  }
}

/**
 * An access token, from the cache when one is still good.
 *
 * What every poll uses. A failure is never cached — a 401 now says nothing
 * about the credential in thirty seconds, and remembering it would turn one
 * revoked-looking blip into an integration that stays broken until a restart.
 */
export async function cachedAccessToken(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<AccessTokenOutcome> {
  const clientEmail = secrets["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const privateKey = secrets["GOOGLE_PRIVATE_KEY"] ?? "";

  if (clientEmail && privateKey) {
    const key = cacheKey(clientEmail, privateKey);
    const held = tokenCache.get(key);

    if (held && held.expiresAt > now) return { ok: true, access: held };
    /* Spent. Dropped rather than left to be overwritten, so a failed refresh
       does not leave an expired token sitting where the next call finds it. */
    if (held) tokenCache.delete(key);

    const minted = await exchangeAccessToken(secrets, fetchImpl, now);
    if (minted.ok) tokenCache.set(key, minted.access);
    return minted;
  }

  return exchangeAccessToken(secrets, fetchImpl, now);
}

/* ------------------------------------------------------------------------- *
 * Reads
 * ------------------------------------------------------------------------- */

/** A tab, as the binding form offers it. */
export interface SheetTab {
  title: string;
  /** Google's own id for the tab. Stable across a rename, unlike the title. */
  sheetId: number;
}

export type TabsOutcome =
  | { ok: true; tabs: SheetTab[] }
  | VerificationFailure;

export type ValuesOutcome =
  /** Rows exactly as Google returned them: ragged, trailing blanks trimmed. */
  | { ok: true; rows: string[][] }
  | VerificationFailure;

/**
 * Every tab in the spreadsheet.
 *
 * `fields` is not an optimisation. Without it Google returns every cell of
 * every sheet, which for a lead list is the entire customer database on a
 * screen whose only question is "which tab". Asking for the properties alone
 * is one small response and nothing sensitive in a log.
 */
export async function listSheetTabs(
  secrets: Readonly<Record<string, string>>,
  spreadsheetId: string,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<TabsOutcome> {
  const access = await cachedAccessToken(secrets, fetchImpl, now);
  if (!access.ok) return access;

  const url =
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}` +
    `?fields=${encodeURIComponent("sheets.properties.title,sheets.properties.sheetId")}`;

  const response = await request(url, access.access.token, secrets, fetchImpl);
  if (!response.ok) return response;

  const body = response.body as {
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  };

  const tabs = (body.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter(
      (properties): properties is { title: string; sheetId: number } =>
        typeof properties?.title === "string" &&
        typeof properties?.sheetId === "number",
    )
    .map((properties) => ({ title: properties.title, sheetId: properties.sheetId }));

  return { ok: true, tabs };
}

/**
 * One tab's cells, as strings.
 *
 * The range is the tab title alone, which Google reads as its whole used
 * range. Naming an explicit A1:Z would silently truncate a sheet with more
 * columns, and the symptom of that is a mapped column that is always empty.
 *
 * UNFORMATTED_VALUE with a string render: a phone number typed into a
 * spreadsheet is a number to Google, and the formatted value of 9876543210 in
 * a cell somebody has styled is "9.87654E+09". Asking for the unformatted
 * value as a string is what keeps the digits.
 */
export async function readSheetValues(
  secrets: Readonly<Record<string, string>>,
  spreadsheetId: string,
  tab: string,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<ValuesOutcome> {
  const access = await cachedAccessToken(secrets, fetchImpl, now);
  if (!access.ok) return access;

  const url =
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(tab)}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const response = await request(url, access.access.token, secrets, fetchImpl);
  if (!response.ok) return response;

  const body = response.body as { values?: unknown };
  const raw = Array.isArray(body.values) ? body.values : [];

  return {
    ok: true,
    rows: raw.map((row) =>
      Array.isArray(row) ? row.map((cell) => cellToString(cell)) : [],
    ),
  };
}

/**
 * A cell as the string a mapping will use.
 *
 * UNFORMATTED_VALUE hands back JSON types, so a number arrives as a number and
 * a checkbox as a boolean. String(9876543210) keeps every digit; String() of a
 * float that a spreadsheet displayed as currency does not, and that is
 * correct — the tenant mapped that column to a template variable and the
 * unrounded value is what their sheet actually holds.
 */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return "";
}

/**
 * One authenticated GET, with every failure already classified and scrubbed.
 *
 * Shared by both reads so a 429 is handled identically wherever it lands —
 * see the Retry-After note in failureDetails.
 */
async function request(
  url: string,
  token: string,
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; body: unknown } | VerificationFailure> {
  const values = Object.values(secrets);

  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    const body = await safeJson(response);

    if (response.ok) return { ok: true, body };

    const error = (body as { error?: { message?: string; status?: string } })
      .error;

    return {
      ok: false,
      kind: classifyStatus(response.status),
      statusCode: response.status,
      error: scrubText(
        error?.message ?? `Sheets API returned ${response.status}.`,
        [...values, token],
      ),
      ...failureDetails(response, error?.status),
    };
  } catch (cause) {
    return transient(cause, values);
  }
}

/**
 * What a failure carries beyond its sentence.
 *
 * `retryAfterMs` is the half that matters for quota. Sheets allows a limited
 * number of reads per minute per project, and one binding polling every thirty
 * seconds is nothing while a hundred is not — so a 429 is not a blip to shrug
 * at, it is the shape of a system at its ceiling. Google sends Retry-After on
 * these; honouring it is the difference between backing off and hammering a
 * quota that is already exhausted.
 *
 * Absent when Google sends no header, which is the caller's cue to use its own
 * back-off rather than to retry immediately.
 */
function failureDetails(
  response: Response,
  status: string | undefined,
): { details?: Record<string, unknown> } {
  const details: Record<string, unknown> = {};

  if (status) details["status"] = status;

  if (response.status === 429) {
    details["quotaExceeded"] = true;

    const header = response.headers.get("retry-after");
    /* Seconds, per RFC 9110. The HTTP-date form is legal and Google does not
       use it; a value that is not a number is ignored rather than guessed at. */
    const seconds = header === null ? Number.NaN : Number(header);

    if (Number.isFinite(seconds) && seconds >= 0) {
      details["retryAfterMs"] = Math.round(seconds * 1000);
    }
  }

  return Object.keys(details).length > 0 ? { details } : {};
}

/** How long a caller should wait, when the failure said. */
export function retryAfterMs(failure: VerificationFailure): number | null {
  const value = failure.details?.["retryAfterMs"];
  return typeof value === "number" ? value : null;
}

/** Whether this failure is Google saying the project is over its read quota. */
export function isQuotaFailure(failure: VerificationFailure): boolean {
  return failure.details?.["quotaExceeded"] === true;
}

/* ------------------------------------------------------------------------- *
 * Verification
 * ------------------------------------------------------------------------- */

export async function verifyGoogleSheets(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<VerificationOutcome> {
  const spreadsheetId = secrets["GOOGLE_SHEETS_ID"] ?? "";
  const clientEmail = secrets["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const privateKey = secrets["GOOGLE_PRIVATE_KEY"] ?? "";

  if (!spreadsheetId || !clientEmail || !privateKey) {
    return {
      ok: false,
      kind: "config",
      error: "Spreadsheet ID, service account email and private key are all required.",
    };
  }

  /* Fresh, never cached. An operator pressing Test Connection is asking what
     the provider says now, not what it said fifty minutes ago. */
  const access = await exchangeAccessToken(secrets, fetchImpl);
  if (!access.ok) return access;

  const outcome = await request(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/A1`,
    access.access.token,
    secrets,
    fetchImpl,
  );

  return outcome.ok ? { ok: true, statusCode: 200 } : outcome;
}

/**
 * Can the service account see this spreadsheet at all?
 *
 * The check a lead source runs on save, and the one whose absence is the most
 * common failure this feature has: the tenant pastes a URL and never shares
 * the sheet, so every poll 404s and nothing happens, silently, for ever.
 *
 * Deliberately not verifyGoogleSheets. That reads GOOGLE_SHEETS_ID from the
 * vault — one spreadsheet per tenant — and a binding names its own.
 */
export async function checkSheetAccess(
  secrets: Readonly<Record<string, string>>,
  spreadsheetId: string,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<VerificationOutcome> {
  const tabs = await listSheetTabs(secrets, spreadsheetId, fetchImpl, now);
  return tabs.ok ? { ok: true, statusCode: 200 } : tabs;
}

function transient(cause: unknown, values: string[]): VerificationFailure {
  return {
    ok: false,
    kind: "transient",
    error: scrubText(describe(cause), values),
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError"
      ? `Timed out after ${PROVIDER_TIMEOUT_MS}ms`
      : cause.message;
  }
  return String(cause);
}

/** A provider returning HTML from a load balancer must not throw here. */
async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
