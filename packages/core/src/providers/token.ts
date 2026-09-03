import { graphGetQuery, type GraphResult } from "./meta.ts";
import type { FetchImpl } from "./types.ts";

/*
 * The pure half lives in integrations.ts, not here.
 *
 * It is a decision about a stored credential with no I/O in it, and the
 * badge, the banner and the reconnect button all need it in a CLIENT
 * bundle. This module reaches the Graph API through meta.ts, and
 * providers/index.ts reaches @node-rs/argon2 by way of the sheets adapter's
 * JWT signing - so an import of anything under providers/ drags native code
 * into the browser graph and the build fails with a trace naming every file
 * except the problem. The conventions record that happening three times.
 *
 * Re-exported so a server-side caller can take both from one place.
 */
export {
  TOKEN_EXPIRY_WARNING_DAYS,
  expiryDemotesStatus,
  tokenExpiryState,
} from "../integrations.ts";
export type { TokenExpiryState } from "../integrations.ts";

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
