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
 * A database we can always connect to in order to CREATE another one, or to
 * ALTER cluster-wide roles. `postgres` always exists and is never the target.
 */
export function maintenanceDatabaseUrl() {
  return withDatabase(required("DATABASE_URL"), "postgres");
}
