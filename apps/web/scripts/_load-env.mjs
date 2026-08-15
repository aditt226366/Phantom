import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Load the repo-root .env, as a side effect, before anything reads it.
 *
 * A separate module because ESM hoists imports: calling dotenv at the top of a
 * script still runs *after* every module that script imports has been
 * evaluated, so lib/env.ts had already parsed an empty environment and called
 * process.exit(1). Importing this first is the only ordering ESM guarantees —
 * the same reason apps/worker/src/index.ts imports its env module first and
 * says so.
 */
loadEnv({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".env",
  ),
  quiet: true,
});
