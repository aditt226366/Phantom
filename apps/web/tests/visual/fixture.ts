import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Who the fixture is, and every page the suite photographs.
 *
 * Imported by both halves — `scripts/visual-seed.mjs` writes these ids and
 * credentials, `pages.spec.ts` signs in with them and builds the URLs. One
 * definition, so a renamed company or a moved route cannot leave the seed and
 * the suite describing different things.
 */

export const FIXTURE = {
  /** The owner of the active company. Signed in for the tenant shell. */
  tenant: { username: "priya_menon", password: "fixture-northwind-2026" },
  /** The platform operator. A separate account space, not a role. */
  admin: { username: "visual_operator", password: "fixture-operator-2026" },
  /** Literal, so every admin URL below is a constant. */
  companyId: "c000visualfixturecompany1",
  /**
   * The owner's last sign-in, as the console renders it.
   *
   * Here rather than only in the seed because signing in overwrites it, and
   * visual.setup.ts has to put back exactly what the seed wrote.
   */
  ownerLastLoginAt: "2026-08-14T09:12:44Z",
} as const;

/**
 * Where visual.setup.ts leaves the two signed-in browser states.
 *
 * Here rather than exported from the setup file itself: Playwright refuses to
 * let one test file import another, and both halves need these paths.
 */
const here = dirname(fileURLToPath(import.meta.url));

export const AUTH = {
  tenant: join(here, ".auth", "tenant.json"),
  admin: join(here, ".auth", "admin.json"),
};

/** Which credentials a page needs, if any. */
export type Audience = "public" | "tenant" | "admin";

export interface VisualRoute {
  /** The screenshot's file name. Changing it re-records rather than diffs. */
  name: string;
  path: string;
  audience: Audience;
}

const company = `/admin/companies/${FIXTURE.companyId}`;

/**
 * Every rendered page.
 *
 * Not generated from the filesystem, deliberately. A route with a dynamic
 * segment needs a real id, a tab needs its query string, and a confirmation
 * step exists only behind one — none of which a directory walk knows. The cost
 * is that a new page has to be added here; the check that it was is the
 * coverage assertion in pages.spec.ts, which walks app/ and fails on anything
 * missing.
 *
 * /reset-password is absent because it renders from a single-use token that
 * would have to be minted per run, which is the one thing a deterministic
 * fixture cannot hold. Its layout is the same auth card as the four pages
 * beside it.
 */
export const ROUTES: readonly VisualRoute[] = [
  { name: "marketing", path: "/", audience: "public" },
  { name: "sign-up", path: "/sign-up", audience: "public" },
  { name: "sign-in", path: "/sign-in", audience: "public" },
  { name: "forgot-password", path: "/forgot-password", audience: "public" },
  { name: "check-email", path: "/check-email", audience: "public" },
  { name: "styleguide", path: "/styleguide", audience: "public" },
  { name: "admin-sign-in", path: "/admin/sign-in", audience: "public" },

  { name: "dashboard", path: "/dashboard", audience: "tenant" },
  { name: "inbox", path: "/inbox", audience: "tenant" },
  { name: "ai-messaging", path: "/ai-messaging", audience: "tenant" },
  { name: "bulk-messaging", path: "/bulk-messaging", audience: "tenant" },
  { name: "template-messaging", path: "/template-messaging", audience: "tenant" },
  { name: "meta-ads", path: "/meta-ads", audience: "tenant" },
  { name: "billing", path: "/billing", audience: "tenant" },
  { name: "configuration", path: "/configuration", audience: "tenant" },
  { name: "profile-personal-details", path: "/profile/personal-details", audience: "tenant" },
  { name: "profile-documents", path: "/profile/documents", audience: "tenant" },

  { name: "admin-overview", path: "/admin", audience: "admin" },
  { name: "admin-companies", path: "/admin/companies", audience: "admin" },
  { name: "company-overview", path: company, audience: "admin" },
  { name: "company-integrations", path: `${company}/integrations`, audience: "admin" },
  { name: "company-verification-logs", path: `${company}/integrations?view=logs`, audience: "admin" },
  { name: "company-documents", path: `${company}/documents`, audience: "admin" },
  { name: "company-billing", path: `${company}/billing`, audience: "admin" },
  { name: "company-deactivate-confirm", path: `${company}?confirm=deactivate`, audience: "admin" },
];
