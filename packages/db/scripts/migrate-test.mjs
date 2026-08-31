import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  TEST_DATABASE_NAME,
  maintenanceDatabaseUrl,
  testDatabaseUrl,
} from "./db-urls.mjs";
import { EXIT_SCHEMA_DRIFT } from "./setup-exit-codes.mjs";

/**
 * Create the test database if it is missing, then bring it up to date.
 *
 * This is a script rather than an npm script line because
 * `DATABASE_URL=x prisma migrate deploy` is not portable: npm spawns commands
 * through cmd.exe on Windows, which has no inline env-var prefix syntax. The
 * usual fix is a cross-env dependency; passing an env object to spawnSync is
 * the same thing without the dependency.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Arbitrary constant identifying this operation cluster-wide.
 *
 * Two concurrent invocations would issue overlapping ALTER ROLE and ALTER
 * DEFAULT PRIVILEGES statements, which take conflicting locks and can deadlock
 * — an intermittent "could not prepare the test database" that reproduces
 * roughly never and wastes an afternoon when it does. The lock makes the second
 * caller wait for the first and then find nothing left to do.
 *
 * Kept, though the case it was written for is gone. It was added when Vitest
 * ran a globalSetup per project and two projects needed this database; that is
 * now hoisted to the root config and runs once per run.
 *
 * It was also the wrong instrument for that problem. Serialising the two setups
 * against each other was never the hazard — the hazard was the second one
 * running at all, reconfiguring roles and grants on a database the first
 * project's workers were already querying. A lock cannot fix that; not running
 * twice can.
 *
 * What remains is what the lock is actually for: this is a public script.
 * `npm run db:test:setup` can be run by hand while a suite is in flight, and a
 * `vitest --watch` in one terminal can overlap a `npm test` in another. Those
 * are genuinely concurrent invocations, and they still deadlock without it.
 */
const SETUP_LOCK_ID = 725_140_921;

const lockHolder = new pg.Client({
  connectionString: maintenanceDatabaseUrl(),
});
await lockHolder.connect();

/* Session-scoped: held until this connection closes, including on a crash. */
await lockHolder.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK_ID]);

try {
  const { rowCount } = await lockHolder.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [TEST_DATABASE_NAME],
  );

  if (rowCount === 0) {
    /*
     * CREATE DATABASE takes no bind parameters. The name is a module constant,
     * never user input.
     */
    await lockHolder.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    console.log(`Created database ${TEST_DATABASE_NAME}.`);
  }

  /*
   * Provision roles and per-database grants before migrating.
   *
   * Role identity is cluster-wide, but schema privileges are not: a database
   * created a moment ago has none of them, and the authentication migration
   * needs app_resolver to hold CREATE on schema public before it can transfer
   * ownership of the SECURITY DEFINER functions. Running db-roles here is what
   * makes `npm test` work against a database that did not exist when the
   * command started.
   */
  const roles = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "db-roles.mjs")],
    { stdio: "inherit" },
  );

  if (roles.status !== 0) {
    process.exit(roles.status ?? 1);
  }

  runMigrations();
  assertTestDatabaseMatchesSchema();
} finally {
  await lockHolder.end();
}

function runMigrations() {

  /*
   * Resolve the Prisma CLI entry point and run it on the current Node binary,
   * rather than spawning `npx` through a shell. `shell: true` concatenates
   * arguments without escaping them (Node DEP0190) and drags in a shell
   * difference between platforms for no benefit.
   */
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");

  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Refuse to run against a test database holding something no migration created.
 *
 * ---------------------------------------------------------------------------
 * Why this runs before the tests rather than after them
 * ---------------------------------------------------------------------------
 *
 * Because the run that INHERITS a stray object is the one that should fail, not
 * the one after it.
 *
 * The case this was written for: a break-once probe added
 * email_verification_tokens.forced_failure — NOT NULL, no default — and its
 * cleanup never ran, most likely because the fork crash killed the worker
 * holding it. The next run then failed 62 tests across 15 files in two
 * projects, with unique and foreign-key violations that read exactly like a
 * broken feature, and the cause was in no migration, no schema.prisma and no
 * source file. Every tool that looks for drift missed it:
 * `prisma migrate deploy` only applies migrations and never removes what one
 * did not create, and the drift check in the conventions runs against the
 * DEVELOPMENT database, which was clean throughout.
 *
 * A trap or a finally in the probe would not have helped. A killed process runs
 * neither. Detection at the start of the next run is the durable answer,
 * because it does not depend on the previous run having exited at all.
 *
 * Held inside the advisory lock with the migration, so a concurrent
 * `npm run db:test:setup` cannot be diffed against half way through applying.
 */
function assertTestDatabaseMatchesSchema() {
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");

  /*
   * --from-config-datasource reads prisma.config.ts, which reads DATABASE_URL —
   * overridden below, so this compares the TEST database against the schema.
   * Piped rather than inherited: the printed steps are the evidence of what
   * drifted, and they are worth showing under our own message rather than on
   * their own.
   */
  const diff = spawnSync(
    process.execPath,
    [
      prismaCli,
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    },
  );

  /* 0 = identical, 2 = a difference, anything else = the check itself failed. */
  if (diff.status === 0) return;

  if (diff.status !== 2) {
    console.error(
      `\nCould not compare ${TEST_DATABASE_NAME} against prisma/schema.prisma ` +
        `(prisma migrate diff exited ${diff.status}).\n`,
    );
    console.error(diff.stderr || diff.stdout || "");
    process.exit(diff.status ?? 1);
  }

  console.error(
    [
      "",
      `${TEST_DATABASE_NAME} does not match prisma/schema.prisma.`,
      "",
      "The migrations all applied, so this is something in the database that no",
      "migration created — most likely a deliberate break whose cleanup never ran",
      "because the process was killed mid-test. It is not a code change, and",
      "looking for one in the diff will waste an afternoon: the symptom is",
      "unrelated suites failing at once with constraint violations.",
      "",
      "Fix it by rebuilding the test database:",
      "",
      "    npm run db:nuke -- test",
      "",
      "Nothing of value lives there — every suite seeds what it needs.",
      "",
      "What the database has that the schema does not (as migration steps that",
      "would bring it back into line):",
      "",
      diff.stdout.trim(),
      "",
    ].join("\n"),
  );

  /* A code of its own, so the globalSetup that spawned this repeats the right
     instruction rather than the generic "is Postgres up". */
  process.exit(EXIT_SCHEMA_DRIFT);
}
