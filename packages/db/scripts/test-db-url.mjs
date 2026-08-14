import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Where the test database lives.
 *
 * DATABASE_URL_TEST wins if it is set. Otherwise the URL is *derived* from
 * DATABASE_URL by swapping the database name, which is deliberate: the local
 * Postgres does not run on 5432 (see POSTGRES_PORT), and a hardcoded test URL
 * silently connects to whatever else is listening on the default port and
 * fails with an authentication error that looks nothing like the real problem.
 * Deriving means host, port and credentials can only ever be right.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(here, "..", "..", "..", ".env"), quiet: true });

export const TEST_DATABASE_NAME = "whatsapp_os_test";

function baseUrl() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return new URL(url);
}

/** Connection string for the test database itself. */
export function testDatabaseUrl() {
  const explicit = process.env["DATABASE_URL_TEST"];
  if (explicit) return explicit;

  const url = baseUrl();
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}

/**
 * Connection string for a database we can connect to in order to CREATE the
 * test database. `postgres` always exists and is never the one being created.
 */
export function maintenanceDatabaseUrl() {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}
