import "server-only";
import {
  listAdAccounts,
  listPages,
  pageWhatsAppLink,
  type GraphResult,
  type MetaAdAccountSummary,
  type MetaPageSummary,
  type PageWhatsAppLink,
} from "@whatsapp-os/core";
import { env } from "@/lib/env";

/**
 * The connect screen's reads, with the same fixture hook the lead-source
 * mapping screen has.
 *
 * ---------------------------------------------------------------------------
 * Why this wrapper exists
 * ---------------------------------------------------------------------------
 *
 * This is the second page in the application that must call a provider before
 * it can render anything, and the argument is the one the conventions already
 * record for the first. There is no network in the gate, so every capture
 * would spend the full ten-second provider timeout and photograph an error
 * state - twice, at two viewports, on every run.
 *
 * And it is a screen very much worth photographing. It is where a tenant
 * chooses which of their ad accounts will spend money and which Page the ads
 * post from, and where they are told - or not - that the Page routes replies
 * to a number this system cannot see. That last sentence is the most
 * consequential piece of copy in the phase and it would otherwise never appear
 * in a baseline.
 *
 * The variable is set by apps/web/playwright.config.ts and by nothing else.
 * It is read through lib/env rather than process.env, which is what makes that
 * a check rather than a hope: webEnvSchema refuses to parse when NODE_ENV is
 * production and the application is not serving whatsapp_os_test, and parseEnv
 * exits non-zero - so an environment that inherited it does not boot.
 *
 * ---------------------------------------------------------------------------
 * What it can and cannot do
 * ---------------------------------------------------------------------------
 *
 * It changes which accounts and Pages a SELECTION SCREEN offers. That is all.
 * It cannot create a campaign, cannot spend anything, and cannot reach the
 * insights sync - the worker has its own calls and does not import this file.
 *
 * The bound it does not have, stated because a test hook in production code
 * earns the question: an operator who set this in production would be offered
 * fictional accounts, and selecting one would store an id that exists nowhere.
 * Nothing would then arrive - the sync would fail against Meta on every run -
 * so the failure is loud rather than silent, which is the opposite of the
 * lead-source case and is why this one is the less dangerous of the two. The
 * value is still a fixed sentinel rather than a path or a blob, so it can only
 * ever produce this one obviously-fake account.
 */

/** The one value that switches this. Anything else calls Meta. */
const FIXTURE_SENTINEL = "meta-ads-visual-fixture";

function usingFixture(): boolean {
  return env.META_ADS_FIXTURE === FIXTURE_SENTINEL;
}

/**
 * The literal the screenshot suite selects from.
 *
 * Two accounts in two currencies, deliberately: the rule that spend is never
 * summed across currencies is invisible with one account, and this is the
 * fixture that makes the connect screen show what a multi-currency tenant
 * actually sees. `act_` ids in an obviously reserved range.
 */
const FIXTURE_ACCOUNTS: MetaAdAccountSummary[] = [
  {
    id: "act_98765000001",
    name: "Northwind Traders — India",
    currency: "INR",
    timezoneName: "Asia/Kolkata",
    accountStatus: 1,
  },
  {
    id: "act_98765000002",
    name: "Northwind Traders — Global",
    currency: "USD",
    timezoneName: "America/Los_Angeles",
    accountStatus: 1,
  },
];

const FIXTURE_PAGES: MetaPageSummary[] = [
  { id: "98765000101", name: "Northwind Traders" },
  { id: "98765000102", name: "Northwind Outlet" },
];

/**
 * The fixture's Page links, and the second one is the point.
 *
 * `98765000101` matches the number the visual seed gives the tenant, so the
 * screen shows the reassuring sentence. `98765000102` is linked somewhere
 * else, so the screen also shows the warning that ads will run and spend while
 * nothing arrives in this inbox. A fixture where every Page matched would
 * photograph only the happy path, and the warning is the copy worth reviewing.
 */
const FIXTURE_PAGE_LINKS: Record<string, PageWhatsAppLink> = {
  "98765000101": { phoneNumber: "+91 98765 43210", wabaId: "98765000201" },
  "98765000102": { phoneNumber: "+91 90000 00000", wabaId: "98765000202" },
};

function fixtureOk<T>(data: T): GraphResult<T> {
  return { ok: true, statusCode: 200, data };
}

export async function readAdAccounts(
  accessToken: string,
): Promise<GraphResult<MetaAdAccountSummary[]>> {
  if (usingFixture()) return fixtureOk(FIXTURE_ACCOUNTS);
  return listAdAccounts(accessToken);
}

export async function readPages(
  accessToken: string,
): Promise<GraphResult<MetaPageSummary[]>> {
  if (usingFixture()) return fixtureOk(FIXTURE_PAGES);
  return listPages(accessToken);
}

export async function readPageWhatsAppLink(
  pageId: string,
  accessToken: string,
): Promise<GraphResult<PageWhatsAppLink>> {
  if (usingFixture()) {
    return fixtureOk(FIXTURE_PAGE_LINKS[pageId] ?? { phoneNumber: null, wabaId: null });
  }
  return pageWhatsAppLink(pageId, accessToken);
}
