import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { AUTH, FIXTURE, ROUTES, type Audience } from "./fixture.ts";

/**
 * Every rendered page, at 1440 and at 390.
 *
 * The suite exists because `max-w-md` compiled to 20px and shipped. Every
 * assertion in the repo passed: the class was in the source, the rule was in
 * the stylesheet, the element had the class. What was wrong was what it looked
 * like, and nothing was looking.
 *
 * A screenshot is a weak assertion — it says "the same as before", not "right"
 * — so the baselines have to be reviewed once, by eye, when they are recorded.
 * That is the whole trade: a human looks at fifty pictures once, and after that
 * the machine notices when one of them changes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "..", "app");

async function settle(page: Page): Promise<void> {
  /*
   * Both faces are self-hosted and preloaded, so this resolves immediately in
   * practice — but a screenshot taken mid-swap photographs the fallback stack
   * at fallback metrics, which moves every line of text on the page. It is one
   * await against a whole class of diff nobody would be able to explain.
   */
  await page.evaluate(() => document.fonts.ready);
}

function shots(audience: Audience, storageState: string | undefined): void {
  test.describe(audience, () => {
    /* An explicitly empty state, not "unset": unset inherits whatever the
       project carries, and a signed-in browser on /sign-in is a redirect. */
    test.use({ storageState: storageState ?? { cookies: [], origins: [] } });

    for (const route of ROUTES.filter((entry) => entry.audience === audience)) {
      test(route.name, async ({ page }) => {
        const response = await page.goto(route.path);

        /* A 500 renders an error page that is perfectly stable and would sit
           in the baselines forever looking like a design decision. */
        expect(response?.status(), `${route.path} did not render`).toBe(200);

        await settle(page);

        /*
         * Checked, not merely photographed.
         *
         * fullPage captures the whole scrollable area, so a page 94px too wide
         * produces a wider baseline that then matches itself forever — the
         * defect recorded as the expected result. Asserting the width makes
         * horizontal overflow a failure with a number in it rather than
         * something to notice.
         *
         * Both faults this found were the same shape: an element that could
         * not shrink. The admin nav on one fixed-height row, and a grid item
         * whose automatic minimum size was the untruncated company name —
         * `truncate` sets white-space: nowrap, which clips the render and
         * leaves min-content alone.
         */
        const width = page.viewportSize()?.width ?? 0;
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );

        expect(
          scrollWidth,
          `${route.path} scrolls sideways at ${width}px`,
        ).toBeLessThanOrEqual(width);

        await expect(page).toHaveScreenshot(`${route.name}.png`, {
          fullPage: true,
        });
      });
    }
  });
}

shots("public", undefined);
shots("tenant", AUTH.tenant);
shots("admin", AUTH.admin);

/**
 * The list above is hand-written, so something has to notice when it stops
 * being complete.
 *
 * Without this, adding a page means adding a page — and the screenshot suite
 * silently covers 25 of 26 routes, which is the same failure as having no
 * suite for the new one while reading as though it is covered.
 */
test.describe("coverage", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("photographs every page under app/", async () => {
    /**
     * Rendered from a single-use token that would have to be minted per run.
     * Deliberately uncovered rather than quietly missing — its card is the
     * same one /forgot-password and /sign-in render, and those are in.
     */
    const EXCLUDED = new Map([["/reset-password", "needs a live reset token"]]);

    const found: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          /* _components and the like are not routes. */
          if (!entry.startsWith("_")) walk(full);
          continue;
        }
        if (entry !== "page.tsx") continue;

        const segments = relative(appDir, dirname(full))
          .split(/[\\/]/)
          .filter((segment) => segment !== "" && !segment.startsWith("("))
          .map((segment) =>
            segment === "[id]" ? FIXTURE.companyId : segment,
          );

        found.push(`/${segments.join("/")}`);
      }
    }

    expect(existsSync(appDir), `app/ not found at ${appDir}`).toBe(true);
    walk(appDir);

    /* Query strings distinguish tabs of one page, not separate pages. */
    const covered = new Set(ROUTES.map((route) => route.path.split("?")[0]));
    const uncovered = found
      .filter((path) => !covered.has(path) && !EXCLUDED.has(path))
      .sort();

    expect(
      uncovered,
      "these pages render and nothing photographs them — add them to ROUTES in fixture.ts",
    ).toEqual([]);

    /* And the reverse: a route that no longer exists would keep passing
       against a stale baseline until somebody noticed the URL 404s. */
    const rendered = new Set(found);
    const stale = [...covered]
      .filter((path) => path !== undefined && !rendered.has(path))
      .sort();

    expect(stale, "these are in ROUTES but no page.tsx renders them").toEqual([]);
  });
});
