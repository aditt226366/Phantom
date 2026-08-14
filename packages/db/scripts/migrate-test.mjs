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

async function ensureDatabase() {
  const client = new pg.Client({ connectionString: maintenanceDatabaseUrl() });
  await client.connect();

  try {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [TEST_DATABASE_NAME],
    );

    if (rowCount === 0) {
      // CREATE DATABASE takes no bind parameters. The name is a module
      // constant, never user input.
      await client.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
      console.log(`Created database ${TEST_DATABASE_NAME}.`);
    }
  } finally {
    await client.end();
  }
}

await ensureDatabase();

/*
 * Resolve the Prisma CLI entry point and run it on the current Node binary,
 * rather than spawning `npx` through a shell. `shell: true` concatenates
 * arguments without escaping them (Node DEP0190) and drags in a shell
 * difference between platforms for no benefit.
 */
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");

const result = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "deploy"],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
