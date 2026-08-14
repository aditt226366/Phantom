import { readFileSync } from "node:fs";

/**
 * The bundled common-password denylist.
 *
 * This is what makes failing open on a HaveIBeenPwned outage defensible. Without
 * it, an HIBP timeout means a signup gets length checking and nothing else, and
 * "password123456" sails through. With it, an outage degrades the breach check
 * from "600 million known-breached passwords" to "the 10,000 that actually get
 * tried" — meaningfully weaker, but not unprotected. Order matters: this runs
 * BEFORE the network call, so the common case never depends on a third party
 * being up.
 *
 * Source: SecLists, Passwords/Common-Credentials/10k-most-common.txt
 * (github.com/danielmiessler/SecLists, MIT). Refresh by replacing the file;
 * nothing here needs to change.
 *
 * Read once at module load. ~72 KB of text becomes a Set of 10,000 strings —
 * a few hundred KB resident, and O(1) lookups for the life of the process.
 */

const listUrl = new URL("./data/common-passwords.txt", import.meta.url);

function loadDenylist(): ReadonlySet<string> {
  const contents = readFileSync(listUrl, "utf8");

  const entries = contents
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);

  return new Set(entries);
}

let cached: ReadonlySet<string> | undefined;

function denylist(): ReadonlySet<string> {
  cached ??= loadDenylist();
  return cached;
}

/** How many entries are loaded. Exposed so a test can catch an empty file. */
export function denylistSize(): number {
  return denylist().size;
}

/**
 * True if the password is one of the common ones.
 *
 * Compared case-insensitively and after NFKC normalisation, so "Password" and
 * "PASSWORD" are caught by the single entry "password". The list is not
 * case-varied, and treating it as case-sensitive would let the most obvious
 * evasion through.
 */
export function isCommonPassword(password: string): boolean {
  return denylist().has(password.normalize("NFKC").trim().toLowerCase());
}
