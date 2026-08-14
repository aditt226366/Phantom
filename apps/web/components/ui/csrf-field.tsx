import { CSRF_FIELD_NAME } from "@/lib/auth/cookies";
import { readCsrfToken } from "@/lib/auth/csrf";

/**
 * The hidden CSRF input, read from the cookie at render time.
 *
 * A Server Component, and it has to be: `cookies()` is server-only. It composes
 * as a *child* of a client `<form>` — server components pass through client
 * components as children — so an interactive form using useActionState does not
 * have to become a server component to include it.
 *
 * The token is minted in proxy.ts, not here: a Server Component cannot call
 * `cookies().set()` during render — a Next.js constraint, not a preference — so
 * the cookie must already exist by the time this runs. An absent cookie renders
 * an empty value and assertCsrf rejects the submission.
 */
export async function CsrfField() {
  const token = await readCsrfToken();

  /*
   * defaultValue, not value: this renders inside a client form, and a `value`
   * with no onChange makes React treat it as a controlled input and warn on
   * every render.
   */
  return <input type="hidden" name={CSRF_FIELD_NAME} defaultValue={token} />;
}
