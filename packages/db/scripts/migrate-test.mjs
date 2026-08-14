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
 * Vitest runs a globalSetup per project, and more than one project needs the
 * test database. Two concurrent invocations would issue overlapping ALTER ROLE
 * and ALTER DEFAULT PRIVILEGES statements, which take conflicting locks and can
 * deadlock — an intermittent "could not prepare the test database" that
 * reproduces roughly never and wastes an afternoon when it does. The lock makes
 * the second caller wait for the first and then find nothing left to do.
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
