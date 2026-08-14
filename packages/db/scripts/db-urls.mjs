import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Connection strings, derived rather than configured.
 *
 * The test URLs are built from DATABASE_URL / DATABASE_URL_APP by swapping the
 * database name. That is deliberate: the local Postgres does not run on 5432
 * (see POSTGRES_PORT), and a hardcoded test URL connects to whatever else is
 * listening on the default port and fails with an authentication error that
 * looks nothing like the real problem. Deriving means host, port and
 * credentials can only ever match the database they are meant to.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(here, "..", "..", "..", ".env"), quiet: true });

export const TEST_DATABASE_NAME = "whatsapp_os_test";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Owner role against the test database. Runs migrations and truncates. */
export function testDatabaseUrl() {
  return (
    process.env["DATABASE_URL_TEST"] ??
    withDatabase(required("DATABASE_URL"), TEST_DATABASE_NAME)
  );
}

/** Runtime (non-owner) role against the test database. The client under test. */
export function testAppDatabaseUrl() {
  return (
    process.env["DATABASE_URL_APP_TEST"] ??
    withDatabase(required("DATABASE_URL_APP"), TEST_DATABASE_NAME)
  );
}

/**
 * A database we can always connect to in order to CREATE another one.
 * `postgres` always exists and is never the target.
 *
 * Connects as whatsapp_owner, which is why that role needs CREATEDB.
 */
export function maintenanceDatabaseUrl() {
  return withDatabase(required("DATABASE_URL"), "postgres");
}

/**
 * The cluster superuser. Used by db-roles.mjs and by nothing else, ever.
 *
 * Creating roles and reassigning table ownership are the only operations in
 * this codebase that genuinely need superuser. Keeping that credential in its
 * own variable means DATABASE_URL unambiguously means whatsapp_owner — the
 * non-superuser, non-BYPASSRLS role that owns the tables and runs migrations.
 */
export function superuserDatabaseUrl() {
  return withDatabase(required("POSTGRES_SUPERUSER_URL"), "postgres");
}

/**
 * Platform-admin role against the test database.
 *
 * Needed because DATABASE_URL_ADMIN in .env points at the development
 * database. Without redirecting it, admin code under test writes to and reads
 * from a completely different database than the one the assertions inspect —
 * which does not error, it just silently returns nothing.
 */
export function testAdminDatabaseUrl() {
  return (
    process.env["DATABASE_URL_ADMIN_TEST"] ??
    withDatabase(required("DATABASE_URL_ADMIN"), TEST_DATABASE_NAME)
  );
}

/**
 * Superuser against the test database.
 *
 * For test scaffolding only — inspecting and mutating rows around an
 * assertion. It exists because the owner cannot do it: FORCE ROW LEVEL
 * SECURITY subjects whatsapp_owner to policies scoped TO app_runtime, so a
 * plain `SELECT * FROM sessions` as the owner returns nothing at all. A
 * superuser bypasses RLS unconditionally, which is exactly what a test harness
 * wants and exactly what application code must never have.
 */
export function testSuperuserDatabaseUrl() {
  return withDatabase(required("POSTGRES_SUPERUSER_URL"), TEST_DATABASE_NAME);
}

/**
 * Fail loudly if any connection string still points at a real database.
 *
 * Called from every test setup file. Three separate variables have now caused
 * this exact failure once each — DATABASE_URL, then DATABASE_URL_APP, then
 * DATABASE_URL_ADMIN — and the failure mode is the worst kind: nothing errors,
 * the code under test reads and writes a different database than the
 * assertions inspect, and the tests fail as though the feature were broken.
 *
 * Asserting it costs one function call and removes the whole class.
 */
export function assertTestDatabaseOnly() {
  const offenders = [];

  for (const [name, value] of Object.entries(process.env)) {
    /* Only connection strings the application itself reads. */
    if (!name.startsWith("DATABASE_URL")) continue;
    if (name.endsWith("_TEST")) continue;
    if (!value) continue;

    const database = new URL(value).pathname.replace(/^\//, "");
    if (database !== TEST_DATABASE_NAME) {
      offenders.push(`${name} -> ${database}`);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `Test setup is pointed at a non-test database:\n  ${offenders.join("\n  ")}\n\n` +
        `Every DATABASE_URL* the app reads must resolve to ${TEST_DATABASE_NAME}. ` +
        "Redirect it in the setup file, or the code under test will quietly " +
        "operate on a different database than the assertions.",
    );
  }
}

/** Databases db-roles.mjs should fix up ownership in, when they exist. */
export function managedDatabaseNames() {
  const devDatabase = new URL(required("DATABASE_URL")).pathname.replace(
    /^\//,
    "",
  );
  return [devDatabase, TEST_DATABASE_NAME];
}
