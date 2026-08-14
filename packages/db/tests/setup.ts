import {
  assertTestDatabaseOnly,
  testAdminDatabaseUrl,
  testAppDatabaseUrl,
  testDatabaseUrl,
} from "../scripts/db-urls.mjs";

/**
 * Per-worker setup.
 *
 * Redirects both connection strings at the test database before any module
 * reads them. The client in src/client.ts is lazy behind a Proxy, so it picks
 * this up on first use — but only if nothing has touched it during import
 * evaluation, which is why this runs as a setupFile rather than inside a test.
 *
 * Note which is which. DATABASE_URL_APP is the non-owner role, and it is what
 * the client under test connects with; tests that need to set up fixtures
 * without tripping RLS use DATABASE_URL (the owner) explicitly.
 */

process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = testDatabaseUrl();
process.env["DATABASE_URL_APP"] = testAppDatabaseUrl();

/*
 * Redirected even though no test in this package uses the admin client: .env
 * points it at the development database, and assertTestDatabaseOnly refuses to
 * let any connection string the app reads escape the test database.
 */
process.env["DATABASE_URL_ADMIN"] = testAdminDatabaseUrl();

/* Fails loudly rather than quietly reading a different database. */
assertTestDatabaseOnly();
