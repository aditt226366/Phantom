import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_SCHEMA_DRIFT } from "../scripts/setup-exit-codes.mjs";

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

  if (result.status === 0) return;

  /*
   * Vitest prints this message last, under the script's own output, so it has
   * to be the right instruction rather than a generic one. A test database
   * holding something no migration created needs rebuilding, not a running
   * Postgres - and repeating "is Postgres up" over a drift failure sends the
   * reader to check a service that is demonstrably working.
   */
  if (result.status === EXIT_SCHEMA_DRIFT) {
    throw new Error(
      "The test database does not match prisma/schema.prisma - see above. " +
        "Rebuild it with `npm run db:nuke -- test`.",
    );
  }

  throw new Error(
    "Could not prepare the test database. Is Postgres up? `npm run services:up`",
  );
}
