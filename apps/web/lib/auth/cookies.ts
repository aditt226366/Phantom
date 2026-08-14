import { SESSION_TTL_MS } from "@whatsapp-os/core";

/**
 * Cookie names and attributes, in one place.
 *
 * These are a security contract, not configuration. Scattering them across the
 * modules that happen to read them is how one call site ends up setting a
 * session cookie without HttpOnly.
 */

/**
 * The `__Host-` prefix is a browser-enforced guarantee: the cookie must be
 * Secure, must have Path=/, and must have no Domain attribute. That last part
 * is what stops a compromised sibling subdomain from writing a cookie the main
 * origin will read — the attack a plain name cannot defend against.
 *
 * It requires HTTPS, and browsers treat `http://localhost` as a secure context,
 * so it would work there. It does *not* work on the LAN address a phone uses to
 * reach a dev server, which is why development gets the unprefixed name.
 */
const prefixed = (name: string): string =>
  process.env.NODE_ENV === "production" ? `__Host-${name}` : name;

export const SESSION_COOKIE_NAME = prefixed("wa_session");
export const CSRF_COOKIE_NAME = prefixed("wa_csrf");

/** The hidden form field CsrfField renders and assertCsrf reads. */
export const CSRF_FIELD_NAME = "csrfToken";

/**
 * Session cookie attributes.
 *
 * `secure: true` unconditionally, and deliberately not
 * `secure: process.env.NODE_ENV === "production"`.
 *
 * That conditional is everywhere, and it buys nothing: browsers already treat
 * `http://localhost` as a secure context and accept Secure cookies there. What
 * it does buy is a line that reads as correct, is never exercised in
 * development, and ships wrong the day NODE_ENV is unset or misspelt in a
 * container — at which point session cookies travel in cleartext and nothing
 * looks broken.
 *
 * SameSite=Lax rather than Strict: Strict withholds the cookie on any
 * cross-site navigation, so following a link from an email into the app lands
 * the user on the sign-in page despite having a valid session. Lax still
 * withholds it on cross-site POSTs, which is the case that matters.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
} as const;

/**
 * CSRF cookie attributes.
 *
 * HttpOnly like the session: only the server reads this. The double-submit
 * pattern is sometimes written with a JavaScript-readable cookie so a fetch
 * wrapper can copy it into a header, but here the value is rendered into the
 * form by a Server Component, so exposing it to script would add reach for no
 * benefit.
 */
export const CSRF_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
} as const;

/** Clearing a cookie has to repeat its attributes or the browser keeps it. */
export const EXPIRED_COOKIE_OPTIONS = {
  ...SESSION_COOKIE_OPTIONS,
  maxAge: 0,
} as const;
