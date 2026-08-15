import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test projects.
 *
 * Two notes that are not obvious and cost an afternoon each if missed:
 *
 * 1. `server.deps.inline` — the workspace packages have `main: ./src/index.ts`
 *    and no build step. Vitest externalises anything under node_modules by
 *    default, so a bare `@whatsapp-os/core` import would be handed to Node as
 *    raw TypeScript. Inlining routes it through Vite's transform instead.
 *
 * 2. `fileParallelism: false` — the db project shares one test database.
 *    Parallel workers interleave their truncations and produce failures that
 *    do not reproduce. (Vitest 4 removed `poolOptions.forks.singleFork`;
 *    `fileParallelism: false` is the replacement and pins maxWorkers to 1.)
 *
 * The file is .mts because the root package.json has no `"type": "module"`,
 * and Vite's native config loader warns on ESM syntax in a file it loads as
 * CommonJS.
 */
/**
 * Installed first in every project, before any other setup file.
 *
 * A process.exit() inside a Vitest fork is reported only as "Worker exited
 * unexpectedly" - no stack, no file, and the tests that never started go
 * missing rather than failing. parseEnv() exits on bad configuration, so
 * anything reaching it from a test dies that way. The guard turns it into a
 * located failure. See tests/no-silent-exit.ts.
 */
const SILENT_EXIT_GUARD = fileURLToPath(
  new URL("./tests/no-silent-exit.ts", import.meta.url),
);

/**
 * Once per run, not once per project.
 *
 * Two projects need a migrated test database - db and web-server - and both
 * used to declare this themselves. That ran it twice against the one shared
 * database, and the second execution issues ALTER ROLE and grant changes
 * through db-roles.mjs while the first project's workers are already querying
 * the database being reconfigured.
 *
 * The advisory lock inside migrate-test.mjs did not help: it serialises the two
 * setups against each other, which was never the hazard. Setting up a shared
 * database a second time while tests are running against it is wrong on its own
 * terms, whatever it turns out to break.
 *
 * Hoisted here, it runs once before any project starts.
 */
const GLOBAL_SETUP = fileURLToPath(
  new URL("./packages/db/tests/global-setup.ts", import.meta.url),
);

export default defineConfig({
  test: {
    globalSetup: [GLOBAL_SETUP],
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          setupFiles: [SILENT_EXIT_GUARD],
          server: { deps: { inline: [/@whatsapp-os\//] } },
        },
      },
      {
        /*
         * The worker's own code. No database and no Redis: what is worth
         * testing here is the logger, and specifically that redaction is wired
         * into it. setupFiles supplies just enough environment for
         * src/env.ts's parseEnv not to process.exit(1) on import.
         */
        test: {
          name: "worker",
          root: "./apps/worker",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          setupFiles: [SILENT_EXIT_GUARD, "./tests/setup.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },
        },
      },
      {
        test: {
          name: "db",
          root: "./packages/db",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          setupFiles: [SILENT_EXIT_GUARD, "./tests/setup.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },

          pool: "forks",
          fileParallelism: false,

          /* Migrations run inside globalSetup on a cold database. */
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
      {
        /*
         * Server-side web code: sessions, CSRF, actions. Node environment and
         * a real database, so it shares the db project's global setup rather
         * than duplicating migration logic. Same single-worker rule — these
         * files truncate shared tables.
         */
        resolve: {
          alias: {
            "@": path.resolve(here, "apps/web"),
            /*
             * `server-only` is a build-time guard whose main entry throws on
             * import outside the react-server condition. Vitest is not a
             * client bundle, so it has nothing to protect and everything to
             * break.
             */
            "server-only": path.resolve(
              here,
              "apps/web/tests/server/server-only-stub.ts",
            ),
          },
        },
        /*
         * The React plugin here too, so a server component can be imported and
         * called directly. The GET-safety check renders the confirmation page
         * and asserts the database is untouched — the only way to test that
         * claim rather than assert a proxy for it.
         */
        plugins: [react()],
        test: {
          name: "web-server",
          root: "./apps/web",
          environment: "node",
          include: ["tests/server/**/*.test.ts"],
          exclude: ["tests/server/setup.ts", "tests/server/server-only-stub.ts"],
          setupFiles: [SILENT_EXIT_GUARD, "./tests/server/setup.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },
          pool: "forks",
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
      {
        /*
         * Component tests. jsdom rather than node, and the React plugin for
         * the JSX transform — Vitest's default esbuild pass does not apply the
         * automatic runtime that React 19 components are written against.
         */
        plugins: [react()],
        resolve: {
          alias: { "@": path.resolve(here, "apps/web") },
        },
        test: {
          name: "web",
          root: "./apps/web",
          environment: "jsdom",
          include: ["tests/*.test.tsx"],
          setupFiles: [SILENT_EXIT_GUARD, "./tests/setup.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },
        },
      },
    ],
  },
});
