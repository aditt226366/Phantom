import { graphGetQuery, type GraphResult } from "./meta.ts";
import type { FetchImpl } from "./types.ts";

/**
 * When a stored credential stops working, and what the console does about it.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * Amendment A3 moved the Meta setup to the tenant: they do their own Meta-side
 * work and produce their own token. That deletes a two-to-four week App Review
 * from the critical path, and it moves token lifetime from being our internal
 * detail to being an operational fact the tenant has to act on.
 *
 * The failure it creates, if nothing here existed, is the quiet one. A token
 * expires; the next insights sync fails; spend stops updating; the dashboard
 * keeps showing last week's figure with no indication it is stale. Nobody
 * notices until somebody asks why the numbers stopped moving, and by then the
 * campaign has been running unwatched for a fortnight.
 *
 * So expiry is recorded when the credential is stored, and read locally on
 * every render. A debug_token call per page load would be a rate limit waiting
 * to happen - and would answer worst at the exact moment it matters most,
 * because a call authorised by an expired token fails too.
 */

/**
 * How long before expiry the console starts asking for a reconnect.
 *
 * Seven days, because a Meta token is renewed by a person doing several steps
 * in Business Manager, and that person has a job. A day's warning is a warning
 * nobody can act on before the weekend.
 */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenExpiryState =
  /** No expiry recorded. Most credentials here genuinely have none. */
  | "no_expiry"
  | "healthy"
  | "expiring"
  | "expired";

/**
 * The state of a stored expiry, as a pure function of two instants.
 *
 * Pure and exported so the badge, the banner and the tests all read the same
 * decision. The alternative - a boolean computed inline in a component - is
 * how "expiring" ends up meaning three days in one place and seven in another.
 *
 * `no_expiry` is deliberately its own member rather than being folded into
 * `healthy`. They are different facts: one is a credential that will never
 * lapse, the other is one that has not lapsed YET, and only the second wants
 * an expiry date rendered beside it. Collapsing them would print "expires
 * never" or nothing at all, and neither is what the operator asked.
 */
export function tokenExpiryState(
  expiresAt: Date | null | undefined,
  now: Date,
): TokenExpiryState {
  if (!expiresAt) return "no_expiry";

  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return "expired";
  if (remaining <= TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) return "expiring";
  return "healthy";
}

/** Whether this state should demote the badge to NOT_CONNECTED. */
export function expiryDemotesStatus(state: TokenExpiryState): boolean {
  /*
   * Only "expired", and the line is drawn here rather than at "expiring" on
   * purpose.
   *
   * An expiring token still works. Demoting it would tell an operator their
   * integration is broken while it is serving traffic perfectly well, and the
   * documented response to a NOT_CONNECTED badge is to re-enter credentials -
   * so a week of warning would become a week of people retyping working
   * secrets. The banner is the right instrument for "act soon"; the badge is
   * for "it does not work now".
   *
   * An expired token is the same class of fact as a 401: the credential is
   * refused. That is the `auth` failure kind, and demotesStatus() in types.ts
   * says auth demotes.
   */
  return state === "expired";
}

/**
 * Ask Meta when a token expires.
 *
 * `debug_token` inspected by the token itself. The documented caller is an app
 * access token, which under A3 we do not have and must not have: an app token
 * is precisely the cross-tenant credential this amendment removed. A token can
 * introspect itself, which is all that is needed here.
 *
 * `expires_at` is Unix SECONDS and 0 means "does not expire" - a long-lived
 * system user token, which is what a well-configured tenant will have. Zero is
 * mapped to null rather than to 1970, which would render as an integration
 * that expired during the Nixon administration.
 */
export async function debugToken(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<{ expiresAt: Date | null; valid: boolean }>> {
  const result = await graphGetQuery<{
    data?: { expires_at?: number; is_valid?: boolean };
  }>(
    "debug_token",
    { input_token: accessToken },
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  const seconds = result.data.data?.expires_at ?? 0;

  return {
    ok: true,
    statusCode: result.statusCode,
    data: {
      expiresAt: seconds > 0 ? new Date(seconds * 1000) : null,
      /* Absent means Meta did not say. Treated as valid: this call exists to
         learn an expiry, and refusing a credential because an optional field
         was missing would demote a working integration on a response shape. */
      valid: result.data.data?.is_valid ?? true,
    },
  };
}
