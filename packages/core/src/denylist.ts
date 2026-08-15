import { COMMON_PASSWORDS } from "./data/common-passwords.ts";

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
 * (github.com/danielmiessler/SecLists, MIT). Refresh by replacing
 * data/common-passwords.txt and running:
 *
 *     npm run build:denylist --workspace=@whatsapp-os/core
 *
 * Built into a Set on first use — 10,000 strings, a few hundred KB resident,
 * and O(1) lookups for the life of the process.
 */

/**
 * ---------------------------------------------------------------------------
 * Embedded, not read from disk
 * ---------------------------------------------------------------------------
 *
 * This used to resolve the .txt with `new URL(..., import.meta.url)` and hand
 * it to readFileSync. Correct Node, correct under Vitest, broken under
 * Turbopack: the bundler supplies its own URL implementation, so the object
 * fails Node's `instanceof URL` check and fs rejects it with
 *
 *     The "path" argument must be of type string or an instance of URL.
 *     Received an instance of URL
 *
 * which reads like a contradiction and means "not the URL class I compare
 * against". Converting with fileURLToPath does not help — the URL handed to it
 * is the foreign one — and that change only moved the failure from runtime to
 * `next build`.
 *
 * So the list is generated into a TypeScript module by
 * scripts/build-denylist.mjs and imported. No filesystem, no import.meta.url,
 * and no outputFileTracingIncludes entry to carry a data file into the
 * deployment. The .txt remains the source of truth and a test asserts the two
 * agree.
 *
 * Same shape as the core barrel pulling @node-rs/argon2 into a client bundle:
 * correct under the test runner, wrong under the bundler, and only reachable
 * once a page actually calls it.
 */
function loadDenylist(): ReadonlySet<string> {
  return new Set(COMMON_PASSWORDS);
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
