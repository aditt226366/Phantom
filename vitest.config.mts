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
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },
        },
      },
      {
        test: {
          name: "db",
          root: "./packages/db",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          globalSetup: ["./tests/global-setup.ts"],
          setupFiles: ["./tests/setup.ts"],
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
          include: ["tests/**/*.test.tsx", "tests/**/*.test.ts"],
          setupFiles: ["./tests/setup.ts"],
          server: { deps: { inline: [/@whatsapp-os\//] } },
        },
      },
    ],
  },
});
