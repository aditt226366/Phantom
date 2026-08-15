import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Turn the denylist text file into a TypeScript module.
 *
 *     npm run build:denylist --workspace=@whatsapp-os/core
 *
 * ---------------------------------------------------------------------------
 * Why the list is embedded rather than read at runtime
 * ---------------------------------------------------------------------------
 *
 * denylist.ts used to resolve the .txt with `new URL(..., import.meta.url)` and
 * hand it to readFileSync. That is correct Node, correct under Vitest, and it
 * breaks under Turbopack: the bundler supplies its own URL implementation, so
 * the object fails Node's `instanceof URL` check and both readFileSync and
 * fileURLToPath reject it with
 *
 *     The "path" argument must be of type string or an instance of URL.
 *     Received an instance of URL
 *
 * — a message that reads like a contradiction and means "not the URL class I
 * compare against". Converting with fileURLToPath does not help, because the
 * URL it is given is the foreign one. Confirmed: that change moved the failure
 * from runtime to `next build`, collecting page data for /billing.
 *
 * The list is static, 10,000 lines, and has not changed since it was added. So
 * it is embedded at build time and there is no filesystem read, no
 * import.meta.url, and no outputFileTracingIncludes entry to carry a data file
 * into the deployment — the entire class of bundler-resolution bugs goes with
 * them.
 *
 * The .txt stays the source of truth: it is reviewable, diffable, and what you
 * replace to refresh from SecLists. Run this afterwards. A test asserts the two
 * agree, so forgetting to is a failing test rather than a stale denylist.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "..", "src", "data", "common-passwords.txt");
const target = path.resolve(here, "..", "src", "data", "common-passwords.ts");

const entries = readFileSync(source, "utf8")
  .split("\n")
  .map((line) => line.trim().toLowerCase())
  .filter((line) => line.length > 0);

if (entries.length === 0) {
  console.error(`${source} produced no entries. Refusing to write an empty list.`);
  process.exit(1);
}

/*
 * JSON.stringify per entry rather than a template literal: these are
 * passwords, and at least one contains a backtick, a dollar or a backslash.
 * Getting the escaping wrong would either break the build or silently change
 * an entry.
 */
const lines = entries.map((entry) => `  ${JSON.stringify(entry)},`).join("\n");

const banner = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced from common-passwords.txt by scripts/build-denylist.mjs. Edit the
 * .txt and re-run that script; a test asserts the two agree.
 *
 * Embedded rather than read from disk because resolving a data file relative
 * to import.meta.url breaks under Turbopack — see the script's header.
 *
 * Source: SecLists, Passwords/Common-Credentials/10k-most-common.txt
 * (github.com/danielmiessler/SecLists, MIT).
 */

export const COMMON_PASSWORDS: readonly string[] = [
${lines}
];
`;

writeFileSync(target, banner, "utf8");

console.log(`Wrote ${entries.length} entries to ${path.relative(process.cwd(), target)}.`);
