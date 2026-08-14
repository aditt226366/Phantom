import {
  testAdminDatabaseUrl,
  testAppDatabaseUrl,
  testDatabaseUrl,
} from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Point the web app's database access at the test database.
 *
 * Mirrors packages/db/tests/setup.ts. DATABASE_URL_APP is the non-owner role
 * everything under test actually connects with; DATABASE_URL is the owner, used
 * only to truncate between tests.
 */

/*
 * NODE_ENV is not assigned here: Next's types mark it readonly, and Vitest
 * already sets it to "test". Asserted instead, because cookies.ts reads it at
 * module load to decide the __Host- prefix, and a stray "production" would
 * change the cookie names out from under every assertion.
 */
if (process.env["NODE_ENV"] === "production") {
  throw new Error("Refusing to run the test suite with NODE_ENV=production");
}

process.env["DATABASE_URL"] = testDatabaseUrl();
process.env["DATABASE_URL_APP"] = testAppDatabaseUrl();

/*
 * Also redirected. .env points DATABASE_URL_ADMIN at the development database,
 * so leaving it alone means admin code under test reads a different database
 * than the assertions inspect — which returns nothing rather than erroring.
 */
process.env["DATABASE_URL_ADMIN"] = testAdminDatabaseUrl();

/* session-store HMACs stored IPs with this. Any 32-byte value works here. */
process.env["ENCRYPTION_KEY"] ??= Buffer.alloc(32).toString("base64");
