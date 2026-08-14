import { NextResponse, type NextRequest } from "next/server";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/cookies";
import { PROTECTED_PREFIXES } from "@/lib/nav";

/**
 * Runs before every matched request.
 *
 * `proxy.ts`, not `middleware.ts`: the middleware file convention is deprecated
 * in Next 16 and renamed to proxy, exporting `proxy`. Proxy also defaults to the
 * Node runtime now, so it *could* reach Postgres.
 *
 * It deliberately does not. Next's own documentation:
 *
 *   "A matcher change or a refactor that moves a Server Function to a different
 *    route can silently remove Proxy coverage. Always verify authentication and
 *    authorization inside each Server Function rather than relying on Proxy
 *    alone."
 *
 * So this does three cheap things, none of which is a security decision:
 *
 *   1. Mints the CSRF cookie when absent. It has to happen here because a
 *      Server Component cannot call cookies().set() during render — a Next
 *      constraint, not a preference — so by the time CsrfField runs, the cookie
 *      must already exist.
 *   2. Redirects to sign-in when the session cookie is *absent*. Presence only,
 *      never validation: this is so an unauthenticated visitor gets a redirect
 *      rather than a flash of the shell. A forged cookie sails straight through
 *      and is rejected by requireSession(), which is the actual boundary.
 *   3. Sets response headers that have no per-route logic.
 */

/**
 * Path prefixes that require a session. Everything else is public.
 *
 * Derived from lib/nav.ts rather than listed again here, so adding a section
 * cannot leave it unprotected — the list and the sidebar are the same list.
 */
function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Headers with no per-route variation.
 *
 * No Content-Security-Policy here: a useful CSP for this app needs a per-request
 * nonce threaded into the Next script tags, and a policy loose enough to work
 * without one is a policy that does not stop very much. It belongs with the
 * work that can do it properly rather than as a header that looks like
 * protection.
 */
function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}

/** The admin panel, which is a separate account space, not a permission. */
const ADMIN_PREFIX = "/admin";
const ADMIN_SIGN_IN = "/admin/sign-in";

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

function mintToken(): string {
  /*
   * Web Crypto rather than node:crypto — available in every runtime proxy can
   * be bundled for.
   */
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  /*
   * Admin first, and with its own cookie and its own destination. An admin who
   * has not signed in must never be sent to the tenant sign-in page: it is a
   * different account space, and landing there implies a tenant account would
   * grant admin access.
   *
   * /admin/sign-in itself is excluded, or it would redirect to itself forever.
   */
  if (isAdminPath(pathname) && pathname !== ADMIN_SIGN_IN) {
    const hasAdmin = Boolean(
      request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value,
    );

    if (!hasAdmin) {
      const target = new URL(ADMIN_SIGN_IN, request.url);
      target.searchParams.set("next", pathname);
      return applySecurityHeaders(NextResponse.redirect(target));
    }
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (!hasSession && isProtected(pathname)) {
    const target = new URL("/sign-in", request.url);
    /*
     * Where they were going, so sign-in can send them back. Taken from the
     * server-parsed pathname, never from a query parameter — and validated
     * again by safeNextPath before anything redirects to it.
     */
    target.searchParams.set("next", pathname);
    return applySecurityHeaders(NextResponse.redirect(target));
  }

  const response = NextResponse.next();

  if (
    isAdminPath(pathname) &&
    !request.cookies.get(ADMIN_CSRF_COOKIE_NAME)?.value
  ) {
    response.cookies.set(ADMIN_CSRF_COOKIE_NAME, mintToken(), CSRF_COOKIE_OPTIONS);
  }

  if (!request.cookies.get(CSRF_COOKIE_NAME)?.value) {
    response.cookies.set(CSRF_COOKIE_NAME, mintToken(), CSRF_COOKIE_OPTIONS);
  }

  return applySecurityHeaders(response);
}

export const config = {
  /*
   * Everything except Next's own assets and static files. Matching those would
   * mint a cookie on every image request for no reason.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
