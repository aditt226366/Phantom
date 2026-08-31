import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every page and every action under (app) consults the gate, or says why not.
 *
 * ---------------------------------------------------------------------------
 * This is the test A4 asks for by name
 * ---------------------------------------------------------------------------
 *
 * "A gate retrofitted onto existing entry points is a gate with a hole in it,
 * and the one that gets missed is the one nobody notices." The gate landing
 * before the feature phases removes most of that risk, but not the part where
 * a section added in Phase 5 or 7 simply forgets - and forgetting is
 * completely silent, because a page with no gate works perfectly.
 *
 * So the coverage is enforced rather than reviewed, in both directions. A new
 * page under (app) fails this until it is either gated or exempted with a
 * reason, and an exemption for a file that no longer exists fails too.
 *
 * ---------------------------------------------------------------------------
 * Parsed, not grepped
 * ---------------------------------------------------------------------------
 *
 * Comments are stripped before matching. Several checks in this repository
 * have flagged their own explanation - no-raw-prisma.test.ts says so in its
 * header, and the admin-db narrowness check hit it too - and this file is
 * about a call that every one of these modules also discusses in prose.
 */

const appRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "app",
  "(app)",
);

/**
 * Entry points that must NOT be gated, each with the reason.
 *
 * Adding a name here opens a route to an unverified workspace, so it should be
 * a deliberate, reviewed diff - the same shape as GLOBAL_TABLES in the schema
 * invariants.
 *
 * A4 names exactly four things an unverified account may do: sign in, sign
 * out, keep its personal details, and file documents. Everything below is one
 * of those.
 */
const UNGATED = new Map<string, string>([
  [
    "layout.tsx",
    "renders the shell and its banner. It calls the gate for the banner but " +
      "must never enforce it - a layout is cached per segment and is not " +
      "guaranteed to re-execute, so a refusal here is one a tenant can " +
      "navigate around. Rule 4.",
  ],
  [
    "actions.ts",
    "sign-out and resend-verification. Both are explicitly allowed while " +
      "blocked, and gating sign-out would trap an unverified user in a " +
      "session they cannot end.",
  ],
  [
    "profile/actions.ts",
    "changing a password. Profile > Personal details is one of the four " +
      "things A4 permits, and a password change is the security-relevant " +
      "half of it.",
  ],
  [
    "profile/personal-details/page.tsx",
    "named in A4 as permitted while blocked.",
  ],
  [
    "profile/documents/page.tsx",
    "the only route OUT of the blocked state. Gating it would be a deadlock " +
      "with no path to verification at all.",
  ],
  [
    "profile/documents/actions.ts",
    "the upload itself, for the same reason as the page above it.",
  ],
]);

/**
 * The call a page makes, and the one an action makes.
 *
 * Matched WITH the opening parenthesis, against a source that has had its
 * import statements removed. Both halves are load-bearing, and break-once
 * proved it: the first version of this file matched the bare identifier, so
 * replacing the call in inbox/page.tsx with a hard-coded `{ allowed: true }`
 * left the import behind and the test went on passing.
 *
 * That is the "assert a value, not a substring" lesson in the conventions
 * file, arriving in the one test whose entire job is to notice a missing
 * check. A gate-coverage test satisfied by an unused import is a gate-coverage
 * test that would have watched the gate be removed.
 */
const PAGE_GATE = "getFeatureAccess(";
const ACTION_GATE = "assertFeatureAccess(";

function entryPoints(): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      /*
       * Pages, layouts and action modules. Deliberately not _components:
       * a component renders inside a page that has already been checked, and
       * requiring a gate call in each would be noise that teaches people to
       * add the call without thinking about it.
       */
      if (/^(page|layout)\.tsx$|^actions\.ts$/.test(entry)) found.push(full);
    }
  }

  walk(appRoot);
  return found;
}

function relativeName(file: string): string {
  return relative(appRoot, file).replace(/\\/g, "/");
}

/**
 * Source with comments AND import statements removed.
 *
 * Comments, because prose about the gate must not satisfy a check about the
 * gate - several assertions in this repository have flagged their own
 * explanation.
 *
 * Imports, because an import is not a call. Without this the check passes on a
 * file that imports the gate and never invokes it, which is precisely the file
 * somebody produces while removing the check and tidying up afterwards.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import[^;]*;/gm, "");
}

describe("the feature gate", () => {
  it("found the entry points to check", () => {
    /* A path bug that produced an empty list would make everything below
       vacuously pass. */
    expect(entryPoints().length).toBeGreaterThan(10);
  });

  it("is called by every page and action that is not exempt", () => {
    const ungated = entryPoints()
      .filter((file) => !UNGATED.has(relativeName(file)))
      .filter((file) => {
        const source = code(file);
        return (
          !source.includes(PAGE_GATE) && !source.includes(ACTION_GATE)
        );
      })
      .map(relativeName);

    expect(
      ungated.sort(),
      "entry points under (app) that never consult canUseFeatures",
    ).toEqual([]);
  });

  it("exempts only files that exist", () => {
    /*
     * A renamed or deleted page leaves a stale exemption behind, and the list
     * still looks deliberate. The failure it would hide is a page recreated
     * under the old name and silently ungated.
     */
    const present = new Set(entryPoints().map(relativeName));

    expect(
      [...UNGATED.keys()].filter((name) => !present.has(name)).sort(),
      "UNGATED names files that do not exist",
    ).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    for (const [name, reason] of UNGATED) {
      expect(reason.length, `${name} is exempted with no reason`).toBeGreaterThan(
        30,
      );
    }
  });

  it("does not enforce the gate in the layout", () => {
    /*
     * The layout may READ the gate - it renders the banner from it - and must
     * never act on it. Rule 4: a layout is cached per segment and is not
     * guaranteed to re-execute on every navigation within one, so a refusal
     * here would be a redirect for the user's benefit masquerading as a
     * boundary, and would make every page's own check look redundant.
     *
     * Asserted rather than trusted, because moving the check up one level is
     * exactly the tidy-up somebody will propose.
     */
    const layout = code(join(appRoot, "layout.tsx"));

    expect(layout).not.toContain(ACTION_GATE);
    expect(
      layout.includes("FeatureBlocked"),
      "the layout renders the blocked state, which makes it the boundary",
    ).toBe(false);
  });

  it("blocks every section a tenant can navigate to", () => {
    /*
     * The complement of the exemption list, stated positively so the set is
     * visible in one place rather than inferred. These are the seven nav
     * sections plus the inbox, which is reachable from the topbar.
     */
    const gated = entryPoints()
      .filter((file) => code(file).includes(PAGE_GATE))
      .map(relativeName)
      .filter((name) => name !== "layout.tsx");

    expect(gated.sort()).toEqual(
      [
        "ai-messaging/page.tsx",
        "billing/page.tsx",
        "bulk-messaging/page.tsx",
        "bulk-messaging/new/page.tsx",
        "bulk-messaging/[broadcastId]/page.tsx",
        "bulk-messaging/[broadcastId]/map/page.tsx",
        "bulk-messaging/[broadcastId]/confirm/page.tsx",
        "configuration/lead-sources/page.tsx",
        "configuration/lead-sources/new/page.tsx",
        "configuration/lead-sources/[leadSourceId]/page.tsx",
        "configuration/lead-sources/[leadSourceId]/map/page.tsx",
        "configuration/numbers/page.tsx",
        "configuration/page.tsx",
        "dashboard/page.tsx",
        "inbox/[conversationId]/page.tsx",
        "inbox/page.tsx",
        "meta-ads/page.tsx",
        "configuration/templates/[templateId]/page.tsx",
        "configuration/templates/new/page.tsx",
        "configuration/templates/page.tsx",
        "template-messaging/page.tsx",
      ].sort(),
    );
  });
});
