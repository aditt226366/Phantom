import { defineConfig, devices } from "@playwright/test";
import {
  testAdminDatabaseUrl,
  testAppDatabaseUrl,
  testDatabaseUrl,
} from "../../packages/db/scripts/db-urls.mjs";

/**
 * The screenshot suite.
 *
 *     npm run test:visual              diff against the committed baselines
 *     npm run test:visual:update       re-record them
 *
 * Six UI commits shipped with every test green and no page ever opened. What
 * caught the collapse in the end was a human looking at a browser, and the
 * only assertion that could have caught it earlier is one about pixels.
 *
 * ---------------------------------------------------------------------------
 * Against a built server, on the test database
 * ---------------------------------------------------------------------------
 *
 * `next start`, not `next dev`: the production build is what ships, and the
 * dev server renders an error overlay and a route-announcer that the built one
 * does not. The port is overridable with VISUAL_PORT.
 *
 * The connection strings are redirected to the test database here rather than
 * left to .env, because the suite's fixture truncates. Real environment
 * variables win over the root .env that next.config.ts loads, so overriding
 * them in `env` below is sufficient and does not require a second .env file.
 *
 * ---------------------------------------------------------------------------
 * Baselines are per platform, and that is not a defect
 * ---------------------------------------------------------------------------
 *
 * Text rasterisation differs between Windows, macOS and Linux — the same
 * Chromium, the same font file, different subpixel output. A single set of
 * baselines would therefore fail everywhere except the machine that recorded
 * them, and the honest options are per-platform baselines or a threshold loose
 * enough to hide real regressions.
 *
 * So {platform} is in the snapshot path. A first run on a platform with no
 * baselines fails with "snapshot missing" and writes what it saw, which says
 * plainly what happened. It does not silently pass.
 */

/*
 * Not 3000, so a dev server can stay up while this runs, and overridable
 * because "already used" is otherwise a config edit rather than a flag.
 */
const PORT = Number(process.env["VISUAL_PORT"] ?? 3210);
const BASE_URL = `http://localhost:${PORT}`;

/*
 * What the app calls itself, which is not where the suite finds it.
 *
 * These were the same value until Configuration > Numbers rendered the webhook
 * address, and this comment used to say the port was not rendered anywhere so
 * changing it could not invalidate a baseline. That stopped being true: APP_URL
 * is now printed on a photographed page, and derived from BASE_URL it would
 * make VISUAL_PORT — an escape hatch for a busy port — silently re-record a
 * screenshot.
 *
 * So it is a literal, on the same rule every id and timestamp in the seed
 * follows: a value this fixture renders is written down, not computed. Nothing
 * navigates by it — Playwright uses baseURL — so it costs nothing to pin.
 */
const FIXTURE_APP_URL = "http://localhost:3210";

export default defineConfig({
  testDir: "./tests/visual",

  /* One worker. The pages share a database and a fixture, and the wall-clock
     saving from more is not worth a suite whose failures do not reproduce. */
  workers: 1,
  fullyParallel: false,

  /* A screenshot that only passes on the second attempt is a screenshot that
     will fail on somebody else's machine. Fix it or re-record it. */
  retries: 0,

  /*
   * Double the default. toHaveScreenshot takes shots until two agree, and
   * /styleguide is 22,000 pixels tall — a couple of megabytes per attempt.
   * It ran out of the 30s default while recording, which is a slow page, not
   * a wrong one.
   */
  timeout: 60_000,

  reporter: process.env["CI"] ? "list" : [["list"], ["html", { open: "never" }]],

  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{platform}/{arg}{ext}",

  use: {
    baseURL: BASE_URL,
    /* globals.css collapses every transition under this query, so the page is
       settled by the time it is photographed rather than probably settled.
       Under contextOptions rather than at the top level: this version of
       Playwright accepts it only there. */
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
  },

  expect: {
    toHaveScreenshot: {
      /*
       * Two thresholds, doing different jobs.
       *
       * `threshold` is per pixel: how different two pixels must be before
       * either counts as changed at all. 0.2 in YIQ space absorbs antialiasing
       * on curved glyph edges and nothing else.
       *
       * `maxDiffPixelRatio` is the budget: 0.1% of the page. A 1440x2000 shot
       * allows about 2,800 changed pixels — enough for the rasteriser to
       * disagree with itself along a few hundred glyph edges, far short of a
       * moved element. The card that collapsed to 20px changed a third of the
       * viewport.
       */
      threshold: 0.2,
      maxDiffPixelRatio: 0.001,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  projects: [
    {
      name: "setup",
      testMatch: /visual\.setup\.ts/,
    },
    {
      name: "desktop",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      /*
       * 390x844 is an iPhone 14/15 in CSS pixels, and the narrowest width this
       * app claims to support. Not devices["iPhone 14"]: that carries
       * deviceScaleFactor 3 and a mobile user agent, which triples the
       * baseline size for no extra coverage of a layout whose only breakpoint
       * inputs are width.
       */
      name: "mobile",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],

  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: testDatabaseUrl(),
      DATABASE_URL_APP: testAppDatabaseUrl(),
      DATABASE_URL_ADMIN: testAdminDatabaseUrl(),
      APP_URL: FIXTURE_APP_URL,
    },
  },
});
