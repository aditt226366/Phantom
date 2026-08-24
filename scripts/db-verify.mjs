import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  runInvariants,
} from "../packages/db/scripts/invariants.mjs";

/**
 * Check one database's catalog invariants. Read-only, and safe to point at
 * production.
 *
 *     npm run db:verify -- dev
 *     npm run db:verify -- test
 *     npm run db:verify -- postgresql://user:pw@host:5432/whatsapp_os
 *
 * ---------------------------------------------------------------------------
 * Why the target is an argument
 * ---------------------------------------------------------------------------
 *
 * These four assertions already existed and already passed, against the test
 * database, on every run. The database that was wrong was dev - missing two
 * column grants for eight commits - and the first symptom was a route that
 * worked in the suite and returned 500 in a browser (C10).
 *
 * Nothing about the assertions was test-specific. Only the connection was.
 *
 * ---------------------------------------------------------------------------
 * This is not `prisma migrate diff`, and does not overlap it
 * ---------------------------------------------------------------------------
 *
 * migrate diff compares tables and columns. It cannot see grants at all - a
 * column grant is not even in pg_class.relacl, it is in pg_attribute.attacl -
 * and it cannot see CHECK constraints, column storage or triggers, none of
 * which schema.prisma can express. It reported "No difference detected" over
 * the drifted database throughout.
 *
 * Run both. They answer different questions.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * Read from .env with dotenv rather than trusting process.env, the way
 * db-urls.mjs and db-nuke.mjs do. An exported DATABASE_URL would otherwise
 * silently decide which database a report was about - and a green report about
 * the wrong database is worse than no report.
 */
loadEnv({ path: path.resolve(here, "..", ".env"), quiet: true });

const target = process.argv[2];

if (!target) {
  console.error(
    [
      "",
      "Usage: npm run db:verify -- <dev|test|connection-url>",
      "",
      "  dev    the database in DATABASE_URL",
      "  test   the same server, whatsapp_os_test",
      "  a URL  anything else, including production",
      "",
      "Read-only. Every statement is a SELECT against a system catalog.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function resolveTarget(argument) {
  const configured = process.env["DATABASE_URL"];

  if (argument === "dev") {
    if (!configured) {
      console.error("DATABASE_URL is not set in .env, so `dev` cannot be resolved.");
      process.exit(2);
    }
    return { label: describe(configured), url: configured };
  }

  if (argument === "test") {
    if (!configured) {
      console.error("DATABASE_URL is not set in .env, so `test` cannot be resolved.");
      process.exit(2);
    }
    /* Derived, never assembled - the port here is not 5432, and a hand-built
       URL reaches whatever else is on the default port. */
    const url = new URL(configured);
    url.pathname = "/whatsapp_os_test";
    return { label: describe(url.toString()), url: url.toString() };
  }

  if (!argument.startsWith("postgres://") && !argument.startsWith("postgresql://")) {
    console.error(`Not a target this understands: ${argument}`);
    console.error("Expected dev, test, or a postgresql:// URL.");
    process.exit(2);
  }

  return { label: describe(argument), url: argument };
}

/** host/database, never the credentials. This prints to a terminal and a log. */
function describe(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

const { label, url } = resolveTarget(target);

console.log(`\nChecking ${label}\n`);

let results;
try {
  results = await runInvariants(url);
} catch (error) {
  console.error(`Could not read the catalog: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let failed = 0;

for (const result of results) {
  if (result.findings.length === 0) {
    console.log(`  ok    ${result.name}`);
    continue;
  }

  failed += result.findings.length;
  console.log(`  FAIL  ${result.name}`);
  for (const finding of result.findings) console.log(`          ${finding}`);
}

if (failed === 0) {
  console.log(`\nAll four invariants hold on ${label}.\n`);
  process.exit(0);
}

console.error(
  [
    "",
    `${failed} finding(s) on ${label}.`,
    "",
    "  Nothing here is visible to `prisma migrate diff`, so a clean drift check",
    "  says nothing about it. The usual cause is a migration that was amended",
    "  after this database had already applied it: migrate deploy considers it",
    "  done and never re-runs it, so the database keeps whatever the first",
    "  version created.",
    "",
    "  Compare the recorded checksums across databases to confirm, then rebuild",
    "  the one that is behind:",
    "",
    "    npm run db:nuke -- dev      (or test)",
    "",
    "  A production database cannot be rebuilt. There the fix is a new, additive",
    "  migration that brings it into line - never an edit to the applied one.",
    "",
  ].join("\n"),
);

process.exit(1);
