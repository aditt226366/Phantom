import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rule 3's raw-SQL clause, enforced rather than remembered.
 *
 * Raw SQL is the one thing in this package the withCompany extension cannot
 * touch. It does not merge companyId into a where, it does not inject it into a
 * create, and it does not refuse a statement naming another company - so a raw
 * statement is scoped by the RLS policy and by nothing else. That is a real
 * boundary and it holds, but it is one layer where everything else has two, and
 * it is worth knowing exactly which files stand on it.
 *
 * Until this test existed the list was a sentence in CLAUDE.md. A fifth site
 * would have been a line in a file nobody diffs against, added by whoever
 * needed it, reviewed as a feature. Now it is a failing security test that has
 * to be answered with a reason, in the same shape as GLOBAL_TABLES,
 * COLUMN_GRANTS and OUT_OF_BAND_DDL.
 *
 * Scoped to src/. Tests are excluded deliberately and not by oversight: the
 * isolation suite is REQUIRED to use raw SQL, because a query through a model
 * in COMPANY_SCOPED_MODELS has its companyId filter injected by the extension
 * and would pass with every policy dropped. no-orm-in-isolation.test.ts
 * enforces that rule in the opposite direction.
 */

/**
 * Files that may execute raw SQL, each because the statement it needs cannot be
 * written any other way.
 *
 * An allowlist, and compared in both directions. A site that no longer needs
 * raw SQL should leave this list, and noticing that is the same review moment
 * as noticing a new one arrive.
 */
const RAW_SQL_ALLOWED = new Map<string, string>([
  [
    "client.ts",
    "SELECT 1 for the health check, and the session-level settings the pool " +
      "applies on connect. Neither addresses a tenant table.",
  ],
  [
    "with-company.ts",
    "set_config('app.company_id', ..., true) is the statement every other " +
      "scope is built on. It cannot itself be scoped.",
  ],
  [
    "resolve-company.ts",
    "SELECT app_resolve_company(...) - a SECURITY DEFINER call made before any " +
      "company context exists, which is the entire point of it.",
  ],
  [
    "company.ts",
    "SELECT app_available_slug(...), the same shape: a definer function " +
      "consulted while creating the company the scope would need.",
  ],
  [
    "vault.ts",
    "SELECT ... FOR UPDATE has no query-builder form, and re-encrypting a " +
      "credential without holding its row loses a concurrent save with no copy " +
      "of the new value anywhere to recover from.",
  ],
  [
    "conversations.ts",
    "GREATEST has no query-builder form. Split into three conditional " +
      "statements the advance has two gaps in it, and concurrent webhook " +
      "deliveries for one thread interleave there - leaving the newest " +
      "timestamp beside the older message's preview.",
  ],
  [
    "media-store.ts",
    "substring(bytes from $1 for $2) is how a stored file is read in chunks " +
      "instead of loaded whole. bytea slicing has no query-builder form, and " +
      "Prisma would materialise the entire value to return it.",
  ],
]);

/*
 * media-store.ts was not in rule 3's list when this test was written, and it
 * had been executing raw SQL since 20260815140000. Nothing was wrong with the
 * code - the slice is scoped by withCompany and by the policy, and the read
 * path has its own isolation tests - but the sentence claiming to enumerate
 * every site had been false for eight commits, which is the failure mode a
 * sentence has and a test does not. It was found by running this file.
 */

/** Prisma's own client. Generated, not authored, and not ours to constrain. */
const GENERATED = "generated";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);

      if (statSync(full).isDirectory()) {
        if (entry !== GENERATED) walk(full);
        continue;
      }

      if (entry.endsWith(".ts")) found.push(full);
    }
  }

  walk(srcRoot);
  return found;
}

/**
 * Strip comments before matching, or this test reads its own explanations.
 *
 * Two checks in this repository have flagged their own prose - the admin-db
 * narrowness check hit exactly this when a comment explained why a Prisma
 * argument type was NOT used, and no-raw-prisma.test.ts says so in its header.
 * Every file allowlisted above explains at length why it holds raw SQL, so a
 * substring match would find each one twice and, worse, would find a file that
 * merely *mentions* $queryRaw in a doc comment.
 *
 * String literals are left alone: a raw call assembled as a string still has to
 * be executed through one of the names below to do anything, and that call site
 * is what this is looking for.
 */
function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      /* The leading character is kept so that :// in a URL is not read as the
         start of a line comment and everything after it discarded. */
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
  );
}

/*
 * Not /g. A global regex carries lastIndex between calls, so .test() inside a
 * filter answers for a different position each time and skips files - which
 * would make this pass by finding nothing.
 */
const RAW_CALL = /\$(?:query|execute)Raw(?:Unsafe)?\b/;
const UNSAFE_CALL = /\$(?:query|execute)RawUnsafe\b/;

function relativeName(file: string): string {
  return relative(srcRoot, file).split(sep).join("/");
}

describe("raw SQL in packages/db", () => {
  it("found source files to check", () => {
    /* A walk that returns nothing would make every assertion below vacuous. */
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("appears only in the files rule 3 names", () => {
    const holders = sourceFiles()
      .filter((file) => RAW_CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map(relativeName);

    /*
     * Both directions in one comparison, like GLOBAL_TABLES. A new site is a
     * widening diff in a security test; a site that has stopped needing raw SQL
     * is a shrinking one, and both should be read by somebody.
     */
    expect(
      holders.sort(),
      "the set of files executing raw SQL has changed — update RAW_SQL_ALLOWED " +
        "and rule 3 in CLAUDE.md together, with the reason",
    ).toEqual([...RAW_SQL_ALLOWED.keys()].sort());
  });

  it("carries a reason for every file that holds it", () => {
    /* An allowlist entry with an empty reason is a name somebody added. */
    for (const [file, reason] of RAW_SQL_ALLOWED) {
      expect(reason.length, `${file} is allowlisted with no reason`).toBeGreaterThan(
        40,
      );
    }
  });

  it("never uses the Unsafe variants, anywhere", () => {
    /*
     * $queryRawUnsafe takes a string instead of a tagged template, so the
     * parameterisation that makes the sanctioned sites safe is optional and
     * invisible at the call site. withCompany makes the same argument about SET
     * LOCAL: a value that decides which tenant's data is visible must never be
     * built by concatenation.
     *
     * No allowlist for this one. If a case ever genuinely needs it, adding the
     * exemption should be its own conversation.
     */
    const offenders = sourceFiles()
      .filter((file) => UNSAFE_CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map(relativeName);

    expect(offenders.sort(), "an Unsafe raw call takes a string, not a template").toEqual(
      [],
    );
  });
});
