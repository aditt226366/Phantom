/**
 * Validate a `?next=` destination before redirecting to it.
 *
 * A post-sign-in redirect that trusts the query string is an open redirect: an
 * attacker sends `/sign-in?next=https://evil.example`, the victim signs in for
 * real, and lands on a page that looks like a continuation of the flow. It is
 * the classic vector for credential phishing precisely because the first half
 * of the journey is genuine.
 *
 * Everything here is a rejection rule. The default is refusal.
 *
 * ---------------------------------------------------------------------------
 * The cases that get missed
 * ---------------------------------------------------------------------------
 *
 *   //evil.example    A protocol-relative URL. It starts with "/", so a naive
 *                     `startsWith("/")` check passes it, and the browser reads
 *                     it as a different origin.
 *
 *   /\evil.example    Browsers normalise a backslash to a forward slash in the
 *                     authority position, so this is the same attack wearing a
 *                     different hat.
 *
 * No `new URL()` parsing with a base either: that happily resolves an absolute
 * URL and hands back a different origin, so the check has to be on the raw
 * string before anything normalises it.
 */

/** Control characters, which can smuggle a newline or NUL past a naive filter. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isSafePath(value: string): boolean {
  if (!value.startsWith("/")) return false;

  /* Protocol-relative, in either slash flavour. */
  const second = value[1];
  if (second === "/" || second === "\\") return false;

  /* A backslash anywhere is not something a real path here needs. */
  if (value.includes("\\")) return false;

  if (CONTROL_CHARACTERS.test(value)) return false;

  return true;
}

/**
 * Return `next` if it is a safe same-origin path, otherwise `fallback`.
 *
 * `prefix` narrows it further — the admin sign-in passes "/admin", so a valid
 * tenant path is still refused there and an admin cannot be bounced into the
 * tenant app by a crafted link.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback: string,
  prefix?: string,
): string {
  if (!next) return fallback;
  if (!isSafePath(next)) return fallback;

  if (prefix && !(next === prefix || next.startsWith(`${prefix}/`))) {
    return fallback;
  }

  return next;
}
