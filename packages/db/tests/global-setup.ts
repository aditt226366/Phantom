import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs once, before any test file in the db project.
 *
 * Delegates to the same script `npm run db:test:setup` uses, so there is one
 * implementation of "get the test database into a known state" rather than two
 * that drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "..", "scripts", "migrate-test.mjs");

export default function setup(): void {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(
      "Could not prepare the test database. Is Postgres up? `npm run services:up`",
    );
  }
}
