import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Contact-number parsing.
 *
 * Stored in E.164 — one canonical representation — so "+91 98765 43210",
 * "098765 43210" and "9876543210" are the same row rather than three.
 */

/** Assumed when the input carries no country code. */
export const DEFAULT_REGION = "IN" as const;

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: string };

/**
 * Parse a contact number to E.164, assuming India when no country code given.
 *
 * `isValid()` rather than `isPossible()`: possible only checks the length is
 * plausible for the region, and would accept a number whose prefix belongs to
 * no carrier. An unreachable contact number is worth rejecting at signup, where
 * the user can still fix it.
 *
 * An explicit country code in the input always wins over the default region, so
 * a "+44…" number is parsed as British regardless.
 */
export function parsePhone(input: string): PhoneResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: "Contact number is required" };
  }

  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_REGION);

  if (!parsed) {
    return { ok: false, reason: "Not a valid contact number" };
  }

  if (!parsed.isValid()) {
    return { ok: false, reason: "Not a valid contact number" };
  }

  return { ok: true, e164: parsed.number };
}
