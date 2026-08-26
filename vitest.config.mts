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

/**
 * No cross-project parallelism, and the reason is the fork crash.
 *
 * `fileParallelism: false` was set on `db` and `web-server` individually, which
 * serialises files *within* a project and does nothing between them - so the db
 * project's workers and web-server's ran at the same time, against the one
 * shared test database. That was the last remaining suspect for the worker that
 * dies with no stack, and the evidence pointed at it twice: the crash never
 * reproduces with `--project db` alone, and its rate rose sharply when Phase 4a
 * added ~60 *web-server* tests and no db tests at all.
 *
 * Hoisted here with `maxWorkers: 1`, one file runs at a time across the whole
 * run. The cost is wall-clock, and it is time already being spent on retries.
 *
 * Measured, twice over five full gates each.
 *
 * Sequential vs the old cross-project overlap: the crash rate fell from about
 * three in four to one in five. A large improvement and not a cure, so this is
 * a mitigation rather than the diagnosis. The cost is wall-clock - the gate
 * roughly doubled, from ~150s to ~300s - which is still less than the retries
 * it saves.
 *
 * `pool: "threads"` on the db project was then tried for five more and is NOT
 * kept. It did not help, for a reason the first five had already hinted at:
 * across all ten runs every worker that died belonged to **web-server**, never
 * to db. "Always the db project" was simply never true, and switching db
 * changed the pool of a project that was not crashing.
 *
 * What the ten runs do establish, and it is worth having:
 *
 *   - it is not cross-project parallelism, which is now gone;
 *   - it is not the db project, which has not lost a worker in ten runs;
 *   - the surviving common factor is a forked worker on a file that talks to
 *     the shared test database, which describes web-server exactly.
 *
 * Still not being chased, by agreement. Recorded so the next attempt starts
 * from here rather than from the db project.
 */
export default defineConfig({
  test: {
    globalSetup: [GLOBAL_SETUP],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    projects: [
      {
        test: {
          name: "core",
          fileParallelism: false,
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
          fileParallelism: false,
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
          fileParallelism: false,
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
