import { scrubText } from "../redact.ts";
import {
  GRAPH_API_BASE,
  PROVIDER_TIMEOUT_MS,
  classifyStatus,
  type FailureKind,
  type FetchImpl,
  type VerificationFailure,
  type VerificationOutcome,
} from "./types.ts";

/**
 * WhatsApp Cloud and Meta Ads, which are the same API wearing two names.
 *
 * Both are Graph endpoints, both return the same error envelope, and both
 * retire on the same schedule — so they share a version constant and an error
 * decoder rather than each growing their own slightly different copy.
 */

/**
 * Graph error codes that mean the credential is refused.
 *
 * 190 is the one that matters: expired, revoked, or invalidated by a password
 * change. It arrives with an HTTP 400 as often as a 401, so status alone
 * classifies it wrong and the badge stays CONNECTED through a real outage of
 * the customer's own making.
 */
const AUTH_CODES = new Set([102, 190, 463, 467]);

/**
 * Codes that mean "not now" rather than "not allowed".
 *
 * 4 and 17 are app and user rate limits, 32 is a page limit, 613 is a custom
 * throttle. All arrive as HTTP 400, so again the status is misleading — and
 * demoting a tenant's badge because Meta throttled us is exactly the wrong
 * response, since the credential is fine and retrying works.
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/**
 * Turn a Graph error envelope into a classified failure.
 *
 * fbtrace_id is kept deliberately. It is the first thing Meta support asks
 * for, it appears only in the response that failed, and it is worth nothing at
 * all if the only place it existed was a log line nobody kept.
 */
export function decodeGraphFailure(
  status: number,
  body: unknown,
  secretValues: readonly string[],
): VerificationFailure {
  const error = ((body as { error?: GraphError } | null)?.error ??
    {}) as GraphError;

  let kind: FailureKind = classifyStatus(status);
  if (error.code !== undefined) {
    if (AUTH_CODES.has(error.code)) kind = "auth";
    else if (TRANSIENT_CODES.has(error.code)) kind = "transient";
  }

  /*
   * Scrubbed, because Meta quotes request parameters back. An "Invalid OAuth
   * access token" message can contain the token that was invalid.
   */
  const message = scrubText(
    error.message ?? `Meta returned ${status}.`,
    secretValues,
  );

  const details: Record<string, unknown> = {};
  if (error.code !== undefined) details["code"] = error.code;
  if (error.error_subcode !== undefined) {
    details["error_subcode"] = error.error_subcode;
  }
  if (error.fbtrace_id !== undefined) details["fbtrace_id"] = error.fbtrace_id;
  if (error.type !== undefined) details["type"] = error.type;

  return {
    ok: false,
    kind,
    statusCode: status,
    error: message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

async function graphGet(
  path: string,
  fields: string,
  accessToken: string,
  secretValues: readonly string[],
  fetchImpl: FetchImpl,
): Promise<VerificationOutcome> {
  try {
    const url = `${GRAPH_API_BASE}/${encodeURIComponent(path)}?fields=${fields}`;

    const response = await fetchImpl(url, {
      /*
       * The token goes in a header, never the query string. Meta accepts
       * ?access_token=, and it would then appear in their access logs, in any
       * proxy between here and them, and in the URL this code logs on failure.
       */
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (response.ok) return { ok: true, statusCode: response.status };

    let body: unknown = {};
    try {
      body = await response.json();
    } catch {
      /* A gateway HTML page is not a Graph envelope. */
    }

    return decodeGraphFailure(response.status, body, secretValues);
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `Timed out after ${PROVIDER_TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);

    return {
      ok: false,
      kind: "transient",
      error: scrubText(message, secretValues),
    };
  }
}

export async function verifyWhatsAppCloud(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<VerificationOutcome> {
  const phoneNumberId = secrets["WHATSAPP_PHONE_NUMBER_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      kind: "config",
      error: "Phone number ID and access token are both required.",
    };
  }

  return graphGet(
    phoneNumberId,
    "verified_name,display_phone_number,quality_rating",
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );
}

export async function verifyMetaAds(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<VerificationOutcome> {
  const accountId = secrets["META_AD_ACCOUNT_ID"] ?? "";
  const accessToken = secrets["META_ADS_ACCESS_TOKEN"] ?? "";

  if (!accountId || !accessToken) {
    return {
      ok: false,
      kind: "config",
      error: "Ad account ID and access token are both required.",
    };
  }

  /* Meta's own identifier form. Accepting it without the prefix is a kindness
     that costs nothing and prevents a confusing 400. */
  const path = accountId.startsWith("act_") ? accountId : `act_${accountId}`;

  return graphGet(
    path,
    "name,account_status,currency",
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );
}

/* ==========================================================================
   Writing to the Graph API
   ========================================================================== */

/**
 * A Graph call that returns something, as opposed to one that only succeeds.
 *
 * The failure branch is VerificationFailure, reused rather than duplicated:
 * one error decoder, one classification, two success shapes. A parallel
 * GraphError type would mean two decoders within a release, which is exactly
 * what the header of this file exists to prevent.
 */
export type GraphResult<T> =
  | { ok: true; statusCode: number; data: T }
  | VerificationFailure;

/**
 * POST to the Graph API, decoded the same way as a GET.
 *
 * Same timeout, same three-class failure kinds, same scrubbing of anything
 * Meta echoes back. The only differences are the body and that success carries
 * a payload.
 */
export async function graphPost<T = unknown>(
  path: string,
  body: unknown,
  accessToken: string,
  secretValues: readonly string[],
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<T>> {
  try {
    const response = await fetchImpl(`${GRAPH_API_BASE}/${path}`, {
      method: "POST",
      headers: {
        /* Header, never the query string - see graphGet. */
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    let parsed: unknown = {};
    try {
      parsed = await response.json();
    } catch {
      /* A gateway HTML page is not a Graph envelope. */
    }

    if (response.ok) {
      return { ok: true, statusCode: response.status, data: parsed as T };
    }

    return decodeGraphFailure(response.status, parsed, secretValues);
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `Timed out after ${PROVIDER_TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);

    return {
      ok: false,
      kind: "transient",
      error: scrubText(message, secretValues),
    };
  }
}
