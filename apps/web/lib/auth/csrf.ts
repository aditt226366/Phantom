import "server-only";
import { cookies } from "next/headers";
import { safeEqual } from "@whatsapp-os/core";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "./cookies.ts";
import type { SessionContext } from "./session-store.ts";

/**
 * CSRF verification. The first line of every mutating action.
 *
 * ---------------------------------------------------------------------------
 * What this actually buys, honestly
 * ---------------------------------------------------------------------------
 *
 * Next already compares Origin against Host for Server Actions and rejects a
 * mismatch, which stops the classic cross-site form post on its own. Setting
 * `serverActions.allowedOrigins` explicitly in next.config.ts is the
 * higher-leverage line of configuration, and it is set.
 *
 * The token earns its place in three cases the built-in check does not cover:
 *
 *   1. POST route handlers, which get no Origin check at all.
 *   2. A reverse proxy that rewrites or strips Origin.
 *   3. allowedOrigins being widened for a preview deployment.
 *
 * It is defence in depth. Do not mistake it for the primary control.
 *
 * ---------------------------------------------------------------------------
 * Two comparisons, not one
 * ---------------------------------------------------------------------------
 *
 * The submitted token must match the cookie (double-submit), and for an
 * authenticated action it must also match the session row's csrfSecret. Those
 * are normally the same value — startSession sets the cookie to the secret —
 * but they diverge precisely in the attack the cookie check cannot see: a
 * sibling subdomain writing the CSRF cookie. Such a token matches the cookie
 * and fails against the session.
 *
 * Both comparisons are constant-time. A token compared with `===` leaks how
 * much of a guess was right and is forgeable one character at a time.
 */

export class CsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

export async function assertCsrf(
  formData: FormData,
  session?: SessionContext | null,
): Promise<void> {
  const submitted = formData.get(CSRF_FIELD_NAME);

  if (typeof submitted !== "string" || submitted.length === 0) {
    throw new CsrfError("Missing CSRF token");
  }

  const store = await cookies();
  const cookieToken = store.get(CSRF_COOKIE_NAME)?.value;

  if (!cookieToken) {
    throw new CsrfError("Missing CSRF cookie");
  }

  if (!safeEqual(submitted, cookieToken)) {
    throw new CsrfError("CSRF token does not match");
  }

  if (session && !safeEqual(submitted, session.csrfSecret)) {
    throw new CsrfError("CSRF token is not bound to this session");
  }
}

/** The value CsrfField renders. Absent before proxy.ts has minted one. */
export async function readCsrfToken(): Promise<string> {
  const store = await cookies();
  return store.get(CSRF_COOKIE_NAME)?.value ?? "";
}
