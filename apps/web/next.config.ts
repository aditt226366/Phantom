import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the repo-root .env.
 *
 * Next resolves .env relative to its own project root (apps/web), so a
 * workspace-level .env is invisible to it. next.config.ts is evaluated before
 * anything else boots, which makes this the right place to bridge that gap.
 *
 * dotenv never overwrites an already-set variable, so real environment
 * variables in CI or a container still win. A missing file is a no-op.
 *
 * Deliberately uses dotenv directly rather than the loadRootEnv helper in
 * @whatsapp-os/core: next.config.ts is loaded by Next's own loader, outside
 * the `transpilePackages` pipeline, so workspace TypeScript is not resolvable
 * here.
 */
loadDotenv({ path: path.resolve(here, "..", "..", ".env"), quiet: true });

const nextConfig: NextConfig = {
  /**
   * The workspace packages ship TypeScript source with no build step, so Next
   * has to compile them the same way it compiles app code.
   */
  transpilePackages: ["@whatsapp-os/core", "@whatsapp-os/db"],

  /**
   * The Postgres driver and BullMQ are Node-native and must not be bundled -
   * they load native/dynamic modules that a bundler cannot statically trace.
   */
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "bullmq", "ioredis"],

  /** Trace from the monorepo root so standalone output picks up workspace deps. */
  outputFileTracingRoot: path.join(here, "../../"),

  typedRoutes: true,
};

export default nextConfig;
