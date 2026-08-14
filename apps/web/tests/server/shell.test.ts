import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUpSchema } from "@whatsapp-os/core";
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
  it("gives every section its own copy", () => {
    /*
     * "A designed empty state, not a spinner" means the copy is the work. A
     * shared string across sections would be the component instance this is
     * meant to avoid.
     */
    const sections = ["ai-messaging", "template-messaging", "bulk-messaging", "meta-ads", "configuration", "inbox"];

    const descriptions = sections.map((section) => {
      const match = /description="([^"]+)"/.exec(pageCode(section));
      return match?.[1];
    });

    expect(descriptions.every(Boolean)).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("says something specific rather than generic", () => {
    /* A description that does not name the feature is a component instance. */
    for (const section of ["ai-messaging", "bulk-messaging", "meta-ads"]) {
      const [, description] = /description="([^"]+)"/.exec(
        pageCode(section),
      ) ?? [];
      expect(description!.length, section).toBeGreaterThan(60);
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
