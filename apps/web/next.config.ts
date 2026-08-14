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
   * The Postgres driver, BullMQ and Argon2 are Node-native and must not be
   * bundled - they load native/dynamic modules that a bundler cannot
   * statically trace. @node-rs/argon2 resolves a platform-specific .node
   * binary at require time; bundling it produces a build that compiles and
   * then throws at the first password hash.
   */
  serverExternalPackages: [
    "@prisma/adapter-pg",
    "pg",
    "bullmq",
    "ioredis",
    "@node-rs/argon2",
  ],

  /** Trace from the monorepo root so standalone output picks up workspace deps. */
  outputFileTracingRoot: path.join(here, "../../"),

  /**
   * The common-password denylist is read from disk at module load, and file
   * tracing cannot see through `new URL(..., import.meta.url)` to know it is
   * needed. Without this the build succeeds and the first signup fails with
   * ENOENT.
   */
  outputFileTracingIncludes: {
    "/**": ["../../packages/core/src/data/common-passwords.txt"],
  },

  typedRoutes: true,

  /**
   * Server Actions are only accepted from these origins.
   *
   * Next compares Origin against Host by default, which already stops the
   * classic cross-site post. Naming the origins explicitly is the
   * higher-leverage control: it survives a reverse proxy that rewrites Host,
   * and it means widening the set for a preview deployment is a visible diff
   * rather than an accident.
   *
   * Host and port only — the field takes no scheme.
   */
  experimental: {
    serverActions: {
      allowedOrigins: [
        new URL(process.env["APP_URL"] ?? "http://localhost:3000").host,
      ],
    },
  },
};

export default nextConfig;
