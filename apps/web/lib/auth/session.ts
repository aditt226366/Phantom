import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  EXPIRED_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "./cookies.ts";
import {
  createSessionRecord,
  resolveSessionByToken,
  revokeSessionByToken,
  type SessionContext,
  type SessionMeta,
} from "./session-store.ts";

/**
 * The session, as the request sees it.
 *
 * ---------------------------------------------------------------------------
 * This is the authorization boundary. Not proxy.ts, and not the layout.
 * ---------------------------------------------------------------------------
 *
 * proxy.ts checks only that a session cookie is *present*, so an unauthenticated
 * visitor gets a redirect instead of a flash of the shell. It validates nothing,
 * and Next's own documentation is explicit that a matcher change or a moved
 * Server Function can silently remove proxy coverage.
 *
 * A layout is no better: layouts are cached per segment and are not guaranteed
 * to re-execute on every navigation within that segment, so `requireSession()`
 * in app/(app)/layout.tsx is a redirect for the user's benefit, not a guard.
 *
 * Every server action and every data loader calls requireSession() itself.
 * React's cache() makes the repeated calls free within a request.
 */

export type { SessionContext } from "./session-store.ts";

/**
 * Read and validate the session for this request.
 *
 * Memoised per request, so calling it in a layout, a page and three actions
 * costs one lookup.
 */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  return resolveSessionByToken(token);
});

/** getSession, or redirect. Use this everywhere a session is required. */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }
  return session;
}

/**
 * Start a session and set both cookies.
 *
 * The CSRF cookie is set to the session's own csrfSecret, which makes the
 * double-submit check and the session binding the same comparison. A token
 * injected into the CSRF cookie by a sibling subdomain would then match the
 * cookie but not the session row, and assertCsrf rejects it.
 */
export async function startSession(
  companyId: string,
  userId: string,
  meta: SessionMeta = {},
): Promise<void> {
  const { token, csrfSecret } = await createSessionRecord(
    companyId,
    userId,
    meta,
  );

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  store.set(CSRF_COOKIE_NAME, csrfSecret, CSRF_COOKIE_OPTIONS);
}

/** Revoke server-side and clear both cookies. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await revokeSessionByToken(token);
  }

  /*
   * Deleting has to repeat the attributes the cookie was set with, or the
   * browser treats it as a different cookie and keeps the original.
   */
  store.set(SESSION_COOKIE_NAME, "", EXPIRED_COOKIE_OPTIONS);
  store.set(CSRF_COOKIE_NAME, "", EXPIRED_COOKIE_OPTIONS);
}

export {
  createSessionRecord,
  resolveSessionByToken,
  revokeSessionByToken,
  sweepExpiredSessions,
} from "./session-store.ts";
