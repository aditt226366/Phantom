import { createSign } from "node:crypto";
import { scrubText } from "../redact.ts";
import {
  PROVIDER_TIMEOUT_MS,
  classifyStatus,
  type FetchImpl,
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
 * dependency than two HTTP calls need. Both hops below go through fetchImpl,
 * which is the entire reason this layer is testable.
 *
 * Two hops: exchange a signed JWT for an access token, then read one cell. The
 * read is the part worth doing. A token exchange only proves the service
 * account exists; fetching A1 proves this spreadsheet is real and shared with
 * it, which is the thing that is actually wrong when a customer says the
 * integration is broken.
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

export async function verifyGoogleSheets(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<VerificationOutcome> {
  const spreadsheetId = secrets["GOOGLE_SHEETS_ID"] ?? "";
  const clientEmail = secrets["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const privateKey = secrets["GOOGLE_PRIVATE_KEY"] ?? "";
  const values = Object.values(secrets);

  if (!spreadsheetId || !clientEmail || !privateKey) {
    return {
      ok: false,
      kind: "config",
      error: "Spreadsheet ID, service account email and private key are all required.",
    };
  }

  let assertion: string;
  try {
    assertion = signServiceAccountJwt(
      clientEmail,
      privateKey,
      Math.floor(Date.now() / 1000),
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

  let token: string;
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
        ...(body.error ? { details: { error: body.error } } : {}),
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

    token = body.access_token;
  } catch (cause) {
    return transient(cause, values);
  }

  try {
    const response = await fetchImpl(
      `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/A1`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );

    if (response.ok) return { ok: true, statusCode: response.status };

    const body = (await safeJson(response)) as {
      error?: { message?: string; status?: string };
    };

    return {
      ok: false,
      kind: classifyStatus(response.status),
      statusCode: response.status,
      error: scrubText(
        body.error?.message ?? `Sheets API returned ${response.status}.`,
        values,
      ),
      ...(body.error?.status ? { details: { status: body.error.status } } : {}),
    };
  } catch (cause) {
    return transient(cause, values);
  }
}

function transient(cause: unknown, values: string[]): VerificationOutcome {
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
