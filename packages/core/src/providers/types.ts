/**
 * What a provider check reports, and how a failure is classified.
 *
 * ---------------------------------------------------------------------------
 * Why a failure has a kind
 * ---------------------------------------------------------------------------
 *
 * IntegrationStatus is CONNECTED or NOT_CONNECTED, and the obvious thing to do
 * with a failed check is set NOT_CONNECTED. That is wrong in a way that costs
 * more than it looks: Meta has an outage, or a request takes three seconds too
 * long, and every tenant's panel now reports a broken integration that is
 * perfectly fine.
 *
 * The operator's response to a panel that says "not connected" is to re-enter
 * credentials, so a transient blip turns into people retyping working secrets —
 * and into support tickets about a product that was never down. Meanwhile a
 * genuinely revoked token looks identical, so the one alert that matters is
 * buried in noise.
 *
 * So a failure says what kind it is, and only some kinds change the badge:
 *
 *   auth       the credential is refused. 401, 403, Meta code 190,
 *              invalid_grant. Demotes: this is what the badge is for.
 *   config     the credential works but points at nothing usable - a
 *              spreadsheet that does not exist, a malformed account id.
 *              Demotes, because it is a real misconfiguration an operator
 *              must fix, and calling it transient would hide it forever.
 *   transient  the provider did not answer usefully. Timeout, 5xx, 429,
 *              connection reset. Records the error, leaves the badge alone.
 *
 * Ambiguity resolves to transient. A wrong badge that says CONNECTED is a
 * delay; a wrong badge that says NOT_CONNECTED is an operator retyping a
 * credential that was never broken.
 */

export type FailureKind = "auth" | "config" | "transient";

export interface VerificationOk {
  ok: true;
  statusCode: number;
}

export interface VerificationFailure {
  ok: false;
  kind: FailureKind;
  statusCode?: number;
  /** Already scrubbed. Safe to store and to show an operator. */
  error: string;
  /**
   * Provider identifiers worth keeping. For Meta: code, error_subcode and
   * fbtrace_id — the last is what their support asks for first, and it is
   * worthless if it was never written down.
   */
  details?: Record<string, unknown>;
}

export type VerificationOutcome = VerificationOk | VerificationFailure;

/** Injected so tests never reach the network, and so the worker can share it. */
export type FetchImpl = typeof fetch;

/**
 * Every provider call carries this.
 *
 * A hung request otherwise holds a worker slot until the process restarts,
 * which in Phase 5's queue is a stall rather than one slow page. Ten seconds
 * is longer than any of these endpoints legitimately takes.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * The Graph API version, in one place.
 *
 * Meta retires versions on a published schedule, so this string changes. Once
 * it is repeated across two adapters that is a migration with a checklist
 * rather than an edit, and the one that gets missed fails in production on
 * Meta's timetable rather than ours.
 */
export const GRAPH_API_VERSION = "v23.0";

export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Whether this failure should move the badge to NOT_CONNECTED. */
export function demotesStatus(kind: FailureKind): boolean {
  return kind !== "transient";
}

/**
 * Classify an HTTP status.
 *
 * 403 counts as auth: both Meta and Google use it for a token that exists but
 * may not do this, which is a credential problem an operator can act on.
 */
export function classifyStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status >= 500) return "transient";
  return "config";
}

/**
 * Classify something thrown rather than returned.
 *
 * Always transient. A timeout, a reset connection, a DNS failure and a TLS
 * error are all "the provider did not answer", and none of them is evidence
 * about the credential. Guessing harder here would only produce confident
 * wrong badges.
 */
export function classifyThrown(error: unknown): FailureKind {
  return "transient";
}
