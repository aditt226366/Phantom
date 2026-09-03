import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/* This directory, for the screenshot stylesheet below. */
const here = dirname(fileURLToPath(import.meta.url));

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
    /*
     * Headroom for the tallest page, and it has to live here rather than
     * inside toHaveScreenshot - that object accepts threshold, ratios, scale
     * and stylePath, and nothing about time.
     *
     * toHaveScreenshot captures repeatedly until two consecutive frames agree.
     * With a diff budget two frames only had to land within it; at zero they
     * have to be identical, and /styleguide is 21,848px and a couple of
     * megabytes a frame. It ran out of the default five seconds once, on a
     * loaded machine, before the sticky fix below made the frames settle.
     *
     * Time, not tolerance. Nothing here makes a difference easier to hide.
     */
    timeout: 30_000,

    toHaveScreenshot: {
      /*
       * Two knobs, and only one of them is allowed to absorb anything.
       *
       * `threshold` is per pixel: how far two pixels may differ in YIQ space
       * before either counts as changed at all. This is the one that exists for
       * rasteriser noise — antialiasing along curved glyph edges, subpixel
       * hinting — and 0.2 absorbs it without reaching a pixel that changed
       * because the markup did.
       *
       * `maxDiffPixelRatio` is a budget for pixels that got past that, and it
       * is zero. A pixel the threshold did not absorb is a pixel that genuinely
       * changed, and there is no number of those a screenshot suite should
       * accept quietly.
       *
       * It used to be 0.001, and that was the two knobs doing each other's
       * jobs. 0.1% of a 1440x900 page is about 1,300 pixels, which is enough to
       * hide a whole CTA: /configuration's call to action was replaced, the
       * 390px shot failed, and the 1440px shot passed and kept a baseline
       * depicting a control the page no longer rendered. A budget wide enough
       * to swallow a button is not a tolerance, it is a blind spot — in the one
       * suite whose entire job is noticing that something looks different.
       *
       * If a run ever goes noisy, that is evidence `threshold` is wrong, and
       * the fix is there. Raising this back up would only re-hide whatever the
       * noise turned out to be.
       */
      threshold: 0.2,
      maxDiffPixelRatio: 0,
      /* Neutralises sticky positioning and backdrop filters, both of which
         make a fullPage capture disagree with itself. See the file. */
      stylePath: join(here, "tests", "visual", "screenshot.css"),
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
      /*
       * The one page in the app that calls Google before it can render.
       *
       * There is no network in the gate, so without this the mapping screen
       * spends the full ten-second provider timeout and then photographs an
       * error state - twice, at two viewports, on every run - and the screen
       * most worth looking at is the one screen never looked at.
       *
       * Read only by lib/lead-sources/sheets.ts, which explains what the hook
       * can and cannot reach. The value is a fixed sentinel rather than a path
       * or a payload, so it can only ever produce one obviously-fake sheet.
       */
      LEAD_SHEET_FIXTURE: "northwind-visual-fixture",

      /*
       * The Verse keys, pinned EMPTY - because /dev/rag renders which of them
       * are configured, and therefore reads the developer's own .env.
       *
       * This is the APP_URL lesson again, one page along. That comment used to
       * say the port was not rendered anywhere; this one would have said the
       * keys were not either, and both stopped being true the moment a page
       * printed them. The failure arrived exactly that way: a real
       * VERSE_V1_API_KEY was added to .env for an unrelated live check, and two
       * baselines went red on a commit that touched neither the page nor the
       * fixture. On a machine with all four set the page would have rendered a
       * fourth state again.
       *
       * Empty rather than fake values, so the photographed state is the one a
       * fresh clone has - the warning that retrieval will fail until these are
       * set. That warning is a designed state worth having a picture of, and
       * pinning it costs no baseline churn.
       *
       * Empty strings and not omissions: next.config.ts loads the root .env,
       * and dotenv fills a key that is ABSENT while leaving one that is present
       * and empty. The same distinction verse-metric-keys.test.ts turns on.
       */
      VERSE_V1_API_KEY: "",
      VERSE_V2_API_KEY: "",
      VERSE_V3_API_KEY: "",
      VERSE_EMBEDDING_API_KEY: "",
    },
  },
});
