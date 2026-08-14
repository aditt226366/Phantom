import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque single-use tokens, for session cookies and verification links.
 *
 * The rule the whole module exists to enforce: the raw token is returned to the
 * caller exactly once and never stored. Only its SHA-256 goes to the database.
 * A dump of `sessions` or `email_verification_tokens` therefore hands over no
 * usable credential — the same reason passwords are hashed, applied to the
 * things that act as passwords.
 *
 * SHA-256 without a salt is correct here, unlike for passwords: these are 32
 * bytes of CSPRNG output, so there is no dictionary to attack and no work
 * factor worth paying on every request.
 */

/** 256 bits. Not guessable, and short enough to sit in a cookie or a URL. */
const TOKEN_BYTES = 32;

/** Verification links expire in a day; long enough for an email to arrive. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

/** Rolling 30-day sessions. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface IssuedToken {
  /**
   * The raw token. Goes in the cookie or the verification URL.
   *
   * Never log it, never persist it, never put it in an error message: it is a
   * bearer credential, and anywhere it lands is somewhere it can be stolen from.
   */
  token: string;
  /** SHA-256 of the token. This is the only form that touches the database. */
  tokenHash: string;
  expiresAt: Date;
}

/** base64url so it is safe in a cookie value and in a query string unescaped. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function issue(ttlMs: number): IssuedToken {
  const token = generateToken();
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

export function issueSessionToken(): IssuedToken {
  return issue(SESSION_TTL_MS);
}

export function issueVerificationToken(): IssuedToken {
  return issue(VERIFICATION_TOKEN_TTL_MS);
}

/**
 * A per-session CSRF secret.
 *
 * Distinct from the session token so that a leak of one does not hand over the
 * other, and so a rotated session token does not invalidate an in-flight form.
 */
export function generateCsrfSecret(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time comparison for token-shaped values.
 *
 * A plain `===` short-circuits on the first differing byte, which leaks how
 * much of a guess was correct and makes a token forgeable one character at a
 * time. Length is compared first because timingSafeEqual throws on a mismatch —
 * that leaks length only, which for fixed-width tokens is already public.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
