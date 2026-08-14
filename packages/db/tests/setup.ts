import { testDatabaseUrl } from "../scripts/test-db-url.mjs";

/**
 * Per-worker setup.
 *
 * Points DATABASE_URL at the test database *before* any module reads it. The
 * client in src/client.ts is lazy behind a Proxy, so it picks this up on first
 * use — but only if nothing has touched it during import evaluation, which is
 * why this runs as a setupFile rather than inside a test.
 */

process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = testDatabaseUrl();
