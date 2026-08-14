import { cookies } from "next/headers";

/**
 * The hidden CSRF input, read from the cookie at render time.
 *
 * A Server Component, and it has to be: `cookies()` is server-only. It composes
 * as a *child* of a client `<form>` — server components pass through client
 * components as children — so an interactive form using useActionState does not
 * have to become a server component to include it.
 *
 *     <SignInForm>       {/* "use client" *\/}
 *       <CsrfField />    {/* server, rendered by the server parent *\/}
 *     </SignInForm>
 *
 * The token is minted in proxy.ts, not here: a Server Component cannot call
 * `cookies().set()` during render — that is a Next.js constraint, not a
 * preference — so the cookie must already exist by the time this runs. An
 * absent cookie renders an empty value, and the action rejects the submission.
 */

/** Form field name. The action reads `formData.get(CSRF_FIELD_NAME)`. */
export const CSRF_FIELD_NAME = "csrfToken";

/**
 * Cookie name.
 *
 * The `__Host-` prefix binds the cookie to an exact origin with no Domain
 * attribute, which is what stops a sibling subdomain from injecting one. It
 * requires Secure, so it is only usable where the app is served over HTTPS —
 * browsers accept Secure on `http://localhost`, but not on the LAN address a
 * phone would use to reach a dev server, so development gets the plain name.
 */
export const CSRF_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-wa_csrf" : "wa_csrf";

export async function CsrfField() {
  const store = await cookies();
  const token = store.get(CSRF_COOKIE_NAME)?.value ?? "";

  /*
   * defaultValue, not value: this is rendered inside a client form, and a
   * `value` with no onChange makes React treat it as a controlled input and
   * warn on every render.
   */
  return <input type="hidden" name={CSRF_FIELD_NAME} defaultValue={token} />;
}
