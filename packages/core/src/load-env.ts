import path from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Load the repo-root .env.
 *
 * Both apps need this and neither gets it for free:
 *   - Next.js reads .env relative to its own project root (apps/web), not the
 *     workspace root.
 *   - tsx does not load .env at all.
 *
 * Resolving from a caller-supplied directory rather than process.cwd() means
 * it works no matter where the command was invoked from.
 *
 * A missing file is not an error: in a container the values come from the
 * environment directly, and dotenv never overwrites a variable that is
 * already set.
 */
export function loadRootEnv(fromDir: string, levelsUp = 2): void {
  const segments = Array.from({ length: levelsUp }, () => "..");
  loadDotenv({
    path: path.resolve(fromDir, ...segments, ".env"),
    quiet: true,
  });
}
