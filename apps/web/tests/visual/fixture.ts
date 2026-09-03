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
   * The two Verse threads, and the pair is the point.
   *
   * One where the knowledge base answered and Verse is still driving, one
   * where nothing cleared the floor and it handed over. The second is the
   * picture that matters most and the one least likely to be looked at: it is
   * the only place the refusal - the whole product - is visible as a thing a
   * customer actually receives.
   */
  verseConversationId: "c000visualfixtureconvo05",
  verseHandoffConversationId: "c000visualfixtureconvo06",
  /** A knowledge base with one document indexed and one failed. */
  knowledgeBaseId: "c000visualfixtureversekb1",
  kbDocumentId: "c000visualfixtureversedoc1",
  kbFailedDocumentId: "c000visualfixtureversedoc2",
  /** A running campaign, with all four recipient states present. */
  campaignId: "c000visualfixtureversecmp1",
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
  /**
   * Three broadcasts, because the interesting screens are three states of one
   * flow and the fifth is a state of one page.
   *
   * The draft still holds its source rows, which is what the mapping and
   * confirm steps render from - confirming clears them, so a sent broadcast
   * has no wizard to return to. The finished one carries real failure rows,
   * because a report with an empty "why messages failed" section is one nobody
   * has ever had to read.
   */
  draftBroadcastId: "c000visualfixturebcast001",
  runningBroadcastId: "c000visualfixturebcast002",
  finishedBroadcastId: "c000visualfixturebcast003",
  /**
   * Two bindings, and the second is the one worth the fixture.
   *
   * The healthy one photographs the live feed with more than one badge in it.
   * The lost one is a binding whose sheet was never shared with the service
   * account - the state a tenant genuinely stares at, and the one least likely
   * to be looked at during development, because everything works on the
   * machine where the share was set up by the person building the feature.
   *
   * The same argument as the unverified workspace above: a fixture that only
   * seeds happy paths never photographs the common case.
   */
  leadSourceId: "c000visualfixtureleadsrc1",
  lostLeadSourceId: "c000visualfixtureleadsrc2",
  /**
   * A published flow with a real multi-node tree behind it.
   *
   * Six nodes rather than a stub, because the builder's whole claim is that a
   * structured list expresses a tree and a picture of two nodes proves nothing
   * about that. It carries every node kind the phase ships except collect.
   */
  flowId: "c000visualfixtureflow00001",
  /**
   * A conversation with a run standing in the middle of it, and one whose
   * 24-hour window shut with the customer halfway down the tree.
   *
   * The paused one is the reason this pair exists. A mid-conversation run is
   * the state anybody building the feature already has on their machine; a
   * paused one takes a day of silence to produce, so nobody waits for it - and
   * it is the state a tenant asks about, because from the outside it looks
   * exactly like the flow having stopped working.
   */
  flowConversationId: "c000visualfixtureflowconv1",
  pausedFlowConversationId: "c000visualfixtureflowconv2",
  /**
   * A verified workspace with no traffic at all, and its owner.
   *
   * The third signed-in state, and the one that photographs what every tenant
   * sees on their first day. It is deliberately NOT the unverified workspace
   * above: that one renders the KYC gate on every page, so it never reaches a
   * feature's own empty state. This one is past the gate and simply has
   * nothing - which on the dashboard is a completely different set of branches
   * from the busy company, and the set least likely to be looked at while the
   * page is being built, because the machine it is built on always has data.
   */
  freshCompanyId: "c000visualfixturecompany4",
  freshTenant: { username: "arjun_v", password: "fixture-northwind-2026" },
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
  freshTenant: join(here, ".auth", "fresh-tenant.json"),
};

/** Which credentials a page needs, if any. */
export type Audience = "public" | "tenant" | "admin" | "blocked" | "fresh";

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
    /* The second view, which is what the inbox used to show by default - the
       one-way threads a broadcast creates are only here. */
    name: "inbox-all",
    path: "/inbox?view=all",
    audience: "tenant",
  },
  /* The queue. Its empty state is the GOOD one, so the fixture seeds a flagged
     thread - otherwise this photographs the screen nobody needs to look at. */
  {
    name: "inbox-attention",
    path: "/inbox?view=attention",
    audience: "tenant",
  },
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
  {
    /* The knowledge base, carrying an indexed document and a failed one. The
       failed row is the reason this shot exists: it proves the worker's
       sentence renders in full rather than collapsing to a red dot. */
    name: "ai-messaging-knowledge",
    path: "/ai-messaging/knowledge",
    audience: "tenant",
  },
  { name: "ai-messaging-new", path: "/ai-messaging/new", audience: "tenant" },
  {
    /* A running campaign, with all four recipient states present so the
       breakdown is four numbers rather than one and three zeroes. */
    name: "ai-messaging-campaign",
    path: `/ai-messaging/${FIXTURE.campaignId}`,
    audience: "tenant",
  },
  {
    name: "ai-messaging-rag",
    path: "/ai-messaging/rag",
    audience: "tenant",
  },
  { name: "template-messaging", path: "/template-messaging", audience: "tenant" },
  {
    name: "template-messaging-new",
    path: "/template-messaging/new",
    audience: "tenant",
  },
  /* The builder, with the published six-node tree loaded into it. */
  {
    name: "flow-builder",
    path: `/template-messaging/${FIXTURE.flowId}`,
    audience: "tenant",
  },
  /* A run mid-conversation, in the thread, rendered by a page that knows
     nothing about flows - which is the point: a flow's messages are ordinary
     message rows. */
  {
    name: "inbox-flow-thread",
    path: `/inbox/${FIXTURE.flowConversationId}`,
    audience: "tenant",
  },
  /* And the paused one, whose window closed mid-run. */
  {
    name: "inbox-flow-paused",
    path: `/inbox/${FIXTURE.pausedFlowConversationId}`,
    audience: "tenant",
  },
  {
    /* Verse answered this one from the knowledge base, and is still driving
       it. The ordinary success, and the control for the picture below. */
    name: "inbox-verse-answered",
    path: `/inbox/${FIXTURE.verseConversationId}`,
    audience: "tenant",
  },
  {
    /*
     * Verse handed this one over, and this is the photograph that matters
     * most in the phase.
     *
     * It is the only place the refusal - which is the entire product - is
     * visible as something a customer actually receives: a question the
     * knowledge base could not answer, a sentence naming no machinery, and a
     * thread flagged for a person with the reason an operator reads. It is
     * also the shot least likely to be looked at, which is why it is seeded
     * with the real handoff copy rather than a placeholder.
     */
    name: "inbox-verse-handoff",
    path: `/inbox/${FIXTURE.verseHandoffConversationId}`,
    audience: "tenant",
  },
  { name: "bulk-messaging", path: "/bulk-messaging", audience: "tenant" },
  { name: "bulk-import", path: "/bulk-messaging/new", audience: "tenant" },
  {
    name: "bulk-mapping",
    path: `/bulk-messaging/${FIXTURE.draftBroadcastId}/map`,
    audience: "tenant",
  },
  {
    name: "bulk-confirm",
    path: `/bulk-messaging/${FIXTURE.draftBroadcastId}/confirm`,
    audience: "tenant",
  },
  {
    /* A draft opened at its report URL. It has no report yet, so it says so
       and points at the confirm step - the state somebody lands on by
       following a stale link from the history list. */
    name: "bulk-draft",
    path: `/bulk-messaging/${FIXTURE.draftBroadcastId}`,
    audience: "tenant",
  },
  {
    name: "bulk-running",
    path: `/bulk-messaging/${FIXTURE.runningBroadcastId}`,
    audience: "tenant",
  },
  {
    /* Finished, and carrying failures grouped by reason. The screen an
       operator actually stares at. */
    name: "bulk-finished",
    path: `/bulk-messaging/${FIXTURE.finishedBroadcastId}`,
    audience: "tenant",
  },
  { name: "templates", path: "/configuration/templates", audience: "tenant" },
  {
    name: "template-library",
    path: "/configuration/templates?view=library",
    audience: "tenant",
  },
  { name: "template-studio-new", path: "/configuration/templates/new", audience: "tenant" },
  {
    /* The rejected one: Meta's reason, the explanation, and the quota. */
    name: "template-rejected",
    path: `/configuration/templates/${FIXTURE.rejectedTemplateId}`,
    audience: "tenant",
  },
  { name: "meta-ads", path: "/meta-ads", audience: "tenant" },
  /* The screen where a tenant chooses which account spends their money, and
     is told - or not - that its Page routes replies somewhere this system
     cannot see. It reaches Meta, so it is only photographable at all because
     META_ADS_FIXTURE answers for it. */
  { name: "meta-ads-connect", path: "/meta-ads/connect", audience: "tenant" },
  /* The builder, whose whole design is that nothing on it starts spending.
     Worth a baseline because that promise is made in copy, and copy is the
     thing a source-level check cannot see. */
  {
    name: "meta-ads-campaign-new",
    path: "/meta-ads/campaigns/new",
    audience: "tenant",
  },
  { name: "billing", path: "/billing", audience: "tenant" },
  { name: "configuration", path: "/configuration", audience: "tenant" },
  { name: "configuration-numbers", path: "/configuration/numbers", audience: "tenant" },
  {
    name: "lead-sources",
    path: "/configuration/lead-sources",
    audience: "tenant",
  },
  {
    /* The binding form, carrying the service account address in full - the
       control a tenant has to use before anything else here works. */
    name: "lead-source-new",
    path: "/configuration/lead-sources/new",
    audience: "tenant",
  },
  {
    /* Active, with recent sends in several states. */
    name: "lead-source-active",
    path: `/configuration/lead-sources/${FIXTURE.leadSourceId}`,
    audience: "tenant",
  },
  {
    /*
     * The mapping screen, with a live preview of what three real rows would
     * receive. Its sheet comes from the fixture reader in
     * lib/lead-sources/sheets.ts - there is no network in the gate, and this
     * is the screen a wrong column is invisible on until you read the
     * sentence.
     */
    name: "lead-source-map",
    path: `/configuration/lead-sources/${FIXTURE.leadSourceId}/map`,
    audience: "tenant",
  },
  {
    /*
     * The lost-access state, and the reason it is seeded rather than left to
     * be imagined. A binding that cannot see its sheet looks exactly like one
     * with no new leads - both show nothing happening - and the difference is
     * a customer list nobody is being contacted from.
     */
    name: "lead-source-lost-access",
    path: `/configuration/lead-sources/${FIXTURE.lostLeadSourceId}`,
    audience: "tenant",
  },
  { name: "profile-personal-details", path: "/profile/personal-details", audience: "tenant" },
  { name: "profile-documents", path: "/profile/documents", audience: "tenant" },

  /*
   * The unverified workspace. Same two routes as above, different account -
   * and completely different pictures, which is why they are worth the second
   * storage state rather than being assumed from the verified ones.
   */
  /*
   * The empty dashboard, which is the first screen of every new account.
   *
   * Worth its own storage state for the reason the unverified workspace is:
   * a fixture that only seeds happy paths never photographs the common case,
   * and this page has a genuinely different shape when every figure is zero -
   * no rates, no ladder, no donut, and six cards each saying what will appear
   * in them.
   */
  { name: "fresh-dashboard", path: "/dashboard", audience: "fresh" },

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
