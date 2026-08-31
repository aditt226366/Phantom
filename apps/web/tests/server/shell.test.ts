import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUpSchema } from "@whatsapp-os/core";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { NAV_SECTIONS, PROFILE_LINKS, PROTECTED_PREFIXES } from "@/lib/nav";
import { revokeSessionByToken, resolveSessionByToken } from "@/lib/auth/session-store";
import { signUp } from "@/lib/auth/signup";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });

afterAll(async () => {
  await raw.end();
});

async function truncateAll(): Promise<void> {
  const { rows } = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await raw.query(
    `TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  await truncateAll();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
});

/*
 * Resolved from this file, not process.cwd(): Vitest's per-project `root` does
 * not change the process working directory, which is the repo root.
 */
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = join(webRoot, "app", "(app)");

function pageSource(...segments: string[]): string {
  return readFileSync(join(appDir, ...segments, "page.tsx"), "utf8");
}

/**
 * Source with comments removed.
 *
 * Needed because these assertions are about what the page *does*, and a comment
 * explaining why something is deliberately absent otherwise reads as its
 * presence — which is exactly what happened on the first run of the Billing
 * test below.
 */
function pageCode(...segments: string[]): string {
  return pageSource(...segments)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The user-facing strings a section renders: its title and description. */
function copyStrings(...segments: string[]): string[] {
  const code = pageCode(...segments);
  return [
    ...code.matchAll(/(?:title|description|lede)=(?:"([^"]+)"|\{`([^`]+)`\})/g),
  ].map((match) => match[1] ?? match[2] ?? "");
}

describe("every shell route is protected", () => {
  /*
   * Read from the source rather than rendered, because rendering a Server
   * Component needs a request. What matters is the invariant: no page may
   * rely on the layout, because layouts are cached per segment and are not
   * guaranteed to re-execute on every navigation within that segment.
   */
  const routes = [
    ...NAV_SECTIONS.map((s) => s.href.replace(/^\//, "")),
    "inbox",
    "profile/personal-details",
    "profile/documents",
  ];

  it.each(routes)("%s calls requireSession itself", (route) => {
    const source = pageSource(...route.split("/"));
    expect(source).toContain("requireSession");
  });

  it("protects every nav path in proxy.ts", () => {
    for (const section of NAV_SECTIONS) {
      expect(PROTECTED_PREFIXES).toContain(section.href);
    }
    expect(PROTECTED_PREFIXES).toContain("/inbox");
    expect(PROTECTED_PREFIXES).toContain("/profile");
  });

  it("covers the profile links too", () => {
    for (const link of PROFILE_LINKS) {
      const covered = PROTECTED_PREFIXES.some((prefix) =>
        link.href.startsWith(prefix),
      );
      expect(covered, `${link.href} is not protected`).toBe(true);
    }
  });
});

describe("Billing", () => {
  it("renders Coming soon and no call to action", () => {
    const code = pageCode("billing");

    expect(code).toContain("Coming soon");
    /* Deliberately not an EmptyState with a button that does nothing. */
    expect(code).not.toContain("<EmptyState");
    expect(code).not.toContain("<Button");
    expect(code).not.toMatch(/from "@\/components\/ui\/(empty-state|button)"/);
  });
});

describe("empty states", () => {
  /*
   * "A designed empty state, not a spinner" means the copy is the work, and a
   * shared string across sections would be the component instance this is meant
   * to avoid.
   *
   * This used to read each page's source for `description="..."`, which worked
   * for exactly as long as every description was a string literal. Template
   * Messaging grew a second one - the tab changes what "empty" means - so the
   * description became a JSX expression, the regex matched nothing, and the
   * test failed because it could no longer see what it was checking.
   *
   * Now it compares values, per the rule that cost this repository the same
   * lesson twice: assert a value, not a substring. A seventh section sharing a
   * sentence is a failing equality rather than a pattern that happens to match.
   */
  it("gives every section its own copy", () => {
    const values = Object.values(EMPTY_COPY);

    expect(values.every((copy) => copy.trim().length > 0)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  /*
   * The other half, and the reason the module is not simply a constants file:
   * a section could still be given copy that nothing renders. Every key must be
   * reachable from the page it names.
   */
  it("is used by the page it names", () => {
    for (const key of Object.keys(EMPTY_COPY)) {
      /*
       * A key is a route, optionally with a "#variant" for a second copy on
       * the same page. It used to be a "-library" suffix stripped by regex,
       * which handled exactly one variant and would have mis-resolved a route
       * genuinely ending in those characters - resolving to a page that does
       * not exist, or worse, to one that does.
       */
      const section = key.split("#")[0] ?? key;
      expect(pageCode(section), `${key} is not rendered`).toContain("EMPTY_COPY");
    }
  });

  it("says something specific rather than generic", () => {
    /* A description that does not name the feature is a component instance.
       Read from the values for the same reason as the check above - this one
       grepped for the same literal and expired at the same moment. */
    for (const section of ["ai-messaging", "bulk-messaging", "meta-ads"] as const) {
      expect(EMPTY_COPY[section].length, section).toBeGreaterThan(60);
    }
  });

  it("uses no exclamation marks in the copy", () => {
    for (const section of NAV_SECTIONS) {
      const dir = section.href.replace(/^\//, "");
      for (const line of copyStrings(dir)) {
        expect(line, `${dir}: "${line}"`).not.toContain("!");
      }
    }
  });
});

describe("logout", () => {
  it("revokes the session row", async () => {
    const result = await signUp(
      signUpSchema.parse({
        fullName: "Ada Lovelace",
        companyName: "Analytical Engines",
        email: "ada@example.test",
        phone: "9876543210",
        username: "ada_l",
        password: "a-sufficiently-long-password",
        confirmPassword: "a-sufficiently-long-password",
      }),
      {},
    );
    if (!result.ok) throw new Error("signup failed");

    expect(await resolveSessionByToken(result.value.sessionToken)).not.toBeNull();

    await revokeSessionByToken(result.value.sessionToken);

    /*
     * Server-side, so it takes effect immediately rather than waiting for a
     * cookie to expire. Clearing the cookie alone would leave a token that
     * still works if it were ever captured.
     */
    expect(await resolveSessionByToken(result.value.sessionToken)).toBeNull();

    const { rows } = await raw.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM sessions",
    );
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it("is a POST, never a link", () => {
    /*
     * A GET logout is prefetchable, and Next prefetches links in the viewport —
     * so a link would sign people out on hover.
     */
    const menu = readFileSync(
      join(webRoot, "components", "app-shell", "profile-menu.tsx"),
      "utf8",
    );

    expect(menu).toContain("<form action={signOutAction}>");
    expect(menu).toContain('type="submit"');
    expect(menu).not.toMatch(/<Link[^>]*sign-?out/i);
  });
});
