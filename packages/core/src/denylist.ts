import { readFileSync } from "node:fs";

/**
 * The bundled common-password denylist.
 *
 * Runs BEFORE the network call, so the common case never depends on a third
 * party being up.
 *
 * ---------------------------------------------------------------------------
 * Be honest about how much this covers
 * ---------------------------------------------------------------------------
 *
 * It is tempting to describe this as making a HaveIBeenPwned outage "degraded
 * rather than unprotected". Measured against the actual policy, it is much
 * weaker than that: the password minimum is 12 characters, and only 10 of these
 * 10,000 entries are that long. The length rule already excludes 99.9% of the
 * list before this function is consulted.
 *
 * So the real coverage during an outage is: length, Argon2id, and roughly ten
 * strings. That is an argument for keeping the check — it costs one Set lookup
 * and catches the ten — and against relying on it. If failing open ever needs
 * to be genuinely defensible, the fix is a corpus of *long* breached passwords,
 * not this file.
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
