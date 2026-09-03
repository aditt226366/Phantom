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
 * run. `web-server` is on threads for the other half of the reason.
 *
 * Measured over fifteen full gates, five per configuration. Two levers, and
 * **both are load-bearing** - neither alone gets to zero.
 *
 *   sequential + all forks        1 in 5 crashed (web-server)   ~300s
 *   sequential + ws on threads    0 in 5 crashed                ~140s
 *   parallel  + ws on threads     1 in 5 crashed (db)           ~135s
 *
 * The third row is the one that settles it. Putting web-server on threads and
 * letting the projects overlap again did not fix anything - the crash simply
 * moved to `db`, the *other* forked project touching the same database. So the
 * serialisation was never merely masking a pool problem, and the pool was never
 * merely masking a concurrency problem. The crash needs a forked worker on a
 * database-touching file AND cross-project overlap; remove either and it stops.
 *
 * Hence both are kept. And the wall-clock argument for dropping the
 * serialisation evaporated once it was measured: threads are enough faster than
 * forks that row two costs ~5s against row three, not the ~165s that row one
 * did. The gate is back to roughly where it was before any of this.
 *
 * `db` stays on forks deliberately. It is the project that has never crashed
 * while web-server was forked, and changing a second thing at the same time
 * would make the next measurement unreadable.
 *
 * ---------------------------------------------------------------------------
 * The conclusion above is WRONG, and this is what falsified it
 * ---------------------------------------------------------------------------
 *
 * "The crash needs a forked worker on a database-touching file AND
 * cross-project overlap; remove either and it stops" did not survive being
 * tested directly. The settings above are all still in place and
 * .git/gate-retries.log passed forty retries, so the crash plainly never
 * stopped - but the shape of it was still being read as a project-overlap
 * problem, because twice in a row the file that never reported was a `db` file
 * and every `worker` file had already finished.
 *
 * scripts/test-floor.mjs now runs the suite as two sequential vitest
 * processes, `!db` then `db`, so there is no overlap of any kind between them:
 * the first process has exited before the second is spawned. Five gates:
 *
 *   1  clean
 *   2  clean
 *   3  the `!db` process died whole - exit 127, no JSON report, three
 *      web-server files in. `db` then ran clean on its own.
 *   4  worker crash INSIDE the `db` process, running alone, with no other
 *      project in it. dashboard-rollup.test.ts never reported.
 *   5  clean
 *
 * Run 4 is decisive. Cross-project overlap was not merely reduced, it was
 * absent - one project, one process - and the crash happened anyway. Whatever
 * this is, it is not the projects interfering with each other, and the fifteen
 * gates above measured something real without identifying it.
 *
 * Run 3 also separated TWO failure modes that forty retries had been recording
 * under one name, because the retry path only ever asked "short, non-zero,
 * nothing actually failing?" and both answer yes:
 *
 *   ONE WORKER DIES. "Worker exited unexpectedly". The run carries on, vitest
 *   still exits non-zero and still writes its JSON report, and the files that
 *   never started go missing rather than failing - so there is always a named
 *   file left behind. Blaming that file is how this investigation ended up at
 *   project transitions in the first place; it was a different `db` file every
 *   time, which should have been the clue.
 *
 *   THE WHOLE PROCESS DIES. Exit 127, no report written at all, the run stops
 *   mid-file with no summary. Nothing is named, because nothing got far enough
 *   to name it.
 *
 * They are not the same event and the second is not rarer - it simply had no
 * evidence to leave.
 *
 * The likelier explanation is underneath all of it and is not a vitest
 * setting. Measured on the machine these gates ran on: 18 GB of process commit
 * and ~23 GB of total commit charge against 16 GB of RAM, with 2.4 GB
 * available at rest. `next build` and a forked worker per test file on top of
 * that is an allocation failure waiting for a place to land, and all three
 * observed symptoms are what that looks like - a fork killed, a process
 * killed, and one Playwright run that took 3.4x its usual time and failed 48
 * screenshots on layout shifts.
 *
 * So the two levers above are kept because they were measured and nothing here
 * argues they made things worse - but they should not be read as a fix. The
 * conventions skill carries the diagnosis under "the machine before the
 * config", and that is the order to work in: this file has now been rewritten
 * twice by people reading a dying fork as a configuration problem.
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
          pool: "threads",
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
