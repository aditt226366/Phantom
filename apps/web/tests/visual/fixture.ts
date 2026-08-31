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
  /**
   * An owner whose workspace is NOT verified, which is where every real tenant
   * starts.
   *
   * A second signed-in state, because the blocked shell is the state most
   * accounts are in on their first day and a suite that only photographs a
   * verified company never sees it. The existing rule, one table over: a
   * fixture that only seeds happy paths never photographs the common case.
   *
   * Its three documents are deliberately in three different states - one
   * approved, one rejected with a reason, one never sent - so the documents
   * page shows every branch it has in one picture, including the upload
   * control that the verified fixture hides on all three rows.
   */
  blockedTenant: { username: "meera_r", password: "fixture-northwind-2026" },
  /** Literal, so every admin URL below is a constant. */
  companyId: "c000visualfixturecompany1",
  /**
   * The open-window thread, which is the one a `[conversationId]` route gets.
   *
   * Here before any page renders it, so that adding the thread page is one
   * entry in ROUTES and nothing else — the walker in pages.spec.ts already
   * substitutes this segment. See DYNAMIC_SEGMENTS there.
   */
  conversationId: "c000visualfixtureconvo01",
  /**
   * The closed-window thread, and the more interesting of the two to look at.
   *
   * It carries everything the open one cannot: a composer disabled with its
   * reason, the template picker disabled beside it, an inbound image served
   * through /api/media, and an outbound message Meta refused.
   */
  closedConversationId: "c000visualfixtureconvo02",
  /**
   * An approved template, carrying variables on purpose.
   *
   * Any approved template with {{n}} needs values typed at send time, so a
   * fixture whose only template is variable-free photographs a picker with
   * nothing to fill in — which is the half of that screen most likely to be
   * wrong.
   */
  approvedTemplateId: "c000visualfixturetmpl001",
  /**
   * A rejected one, carrying a real Meta rejection reason.
   *
   * Rejected for the reason its own body demonstrates: it opens on a variable,
   * which is one of the three rules validateTemplate enforces. The fixture and
   * the validator describe the same rule from opposite ends.
   */
  rejectedTemplateId: "c000visualfixturetmpl002",
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
  blockedTenant: join(here, ".auth", "blocked-tenant.json"),
};

/** Which credentials a page needs, if any. */
export type Audience = "public" | "tenant" | "admin" | "blocked";

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
  {
    name: "inbox-thread-open",
    path: `/inbox/${FIXTURE.conversationId}`,
    audience: "tenant",
  },
  {
    name: "inbox-thread-closed",
    path: `/inbox/${FIXTURE.closedConversationId}`,
    audience: "tenant",
  },
  { name: "ai-messaging", path: "/ai-messaging", audience: "tenant" },
  { name: "bulk-messaging", path: "/bulk-messaging", audience: "tenant" },
  { name: "template-messaging", path: "/template-messaging", audience: "tenant" },
  {
    name: "template-library",
    path: "/template-messaging?view=library",
    audience: "tenant",
  },
  { name: "template-studio-new", path: "/template-messaging/new", audience: "tenant" },
  {
    /* The rejected one: Meta's reason, the explanation, and the quota. */
    name: "template-rejected",
    path: `/template-messaging/${FIXTURE.rejectedTemplateId}`,
    audience: "tenant",
  },
  { name: "meta-ads", path: "/meta-ads", audience: "tenant" },
  { name: "billing", path: "/billing", audience: "tenant" },
  { name: "configuration", path: "/configuration", audience: "tenant" },
  { name: "configuration-numbers", path: "/configuration/numbers", audience: "tenant" },
  { name: "profile-personal-details", path: "/profile/personal-details", audience: "tenant" },
  { name: "profile-documents", path: "/profile/documents", audience: "tenant" },

  /*
   * The unverified workspace. Same two routes as above, different account -
   * and completely different pictures, which is why they are worth the second
   * storage state rather than being assumed from the verified ones.
   */
  { name: "blocked-dashboard", path: "/dashboard", audience: "blocked" },
  { name: "blocked-inbox", path: "/inbox", audience: "blocked" },
  {
    name: "blocked-documents",
    path: "/profile/documents",
    audience: "blocked",
  },

  { name: "admin-overview", path: "/admin", audience: "admin" },
  { name: "admin-companies", path: "/admin/companies", audience: "admin" },
  { name: "company-overview", path: company, audience: "admin" },
  { name: "company-integrations", path: `${company}/integrations`, audience: "admin" },
  { name: "company-verification-logs", path: `${company}/integrations?view=logs`, audience: "admin" },
  { name: "company-documents", path: `${company}/documents`, audience: "admin" },
  {
    /* The irreversible one, behind its confirm step. Photographed for the
       reason company-deactivate-confirm is: a destructive panel nobody has
       looked at is one whose copy nobody has read. */
    name: "company-documents-erase-confirm",
    path: `${company}/documents?confirm=erase`,
    audience: "admin",
  },
  { name: "company-billing", path: `${company}/billing`, audience: "admin" },
  { name: "company-deactivate-confirm", path: `${company}?confirm=deactivate`, audience: "admin" },
];
