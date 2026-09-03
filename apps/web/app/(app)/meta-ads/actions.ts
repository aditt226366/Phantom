"use server";

import { revalidatePath } from "next/cache";
import {
  JOB_NAMES,
  createPausedCampaign,
  metaInsightsSchedulerId,
  setCampaignStatus,
  type MetaCampaignObjectiveName,
} from "@whatsapp-os/core";
import {
  findAdAccount,
  findCampaign,
  pauseCampaign,
  publishCampaign,
  recordCampaign,
  removeAdAccount,
  selectAdAccount,
  whatsappNumbersForMatching,
  withCompany,
} from "@whatsapp-os/db";
import { systemQueue } from "@/lib/queue";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { loadMetaAdsCredentials } from "@/lib/meta-ads/credentials";
import { readAdAccounts, readPageWhatsAppLink } from "@/lib/meta-ads/graph";
import { parseDailyBudget } from "@/lib/meta-ads/budget";
import { checkLinkedNumber } from "@/lib/meta-ads/linked-number";

/**
 * Everything the Meta Ads section can do.
 *
 * Every action calls requireSession() and assertFeatureAccess() itself. Rule 4:
 * the layout's check is a redirect for the user's benefit, and a server action
 * is reachable by its id whatever the page rendered.
 */

export interface MetaAdsState {
  error?: string;
  notice?: string;
}

/**
 * How often an account's spend is re-read.
 *
 * Six hours, and the number is a rate-limit budget rather than a freshness
 * one. Meta restates a day for most of a week, so nothing is gained by asking
 * every minute - and their limits are per APP, shared across every tenant on
 * this deployment, so a tighter interval is a cost the next customer pays.
 *
 * The dashboard says how old the figure is rather than pretending it is live,
 * which is the same choice the rollup already made.
 */
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Register the per-account sync.
 *
 * Derived from the account row id, because upsertJobScheduler is an upsert on
 * that key: re-running the connect screen replaces the schedule instead of
 * adding a second one. A random id would leave the old schedule running and
 * the account would sync twice as often - which is a shared rate limit against
 * Meta, so it is every other tenant's problem before it is this one's.
 *
 * The fifth caller of that argument, after lead sources, the dashboard rollup
 * and Verse campaigns.
 */
async function registerInsightsSync(companyId: string, adAccountId: string) {
  await systemQueue.upsertJobScheduler(
    metaInsightsSchedulerId(adAccountId),
    { every: SYNC_EVERY_MS },
    {
      name: JOB_NAMES.META_INSIGHTS_SYNC,
      data: { companyId, adAccountId, lookbackDays: 28 },
    },
  );
}

export async function selectAdAccountAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const metaAdAccountId = String(formData.get("adAccountId") ?? "").trim();
  const pageId = String(formData.get("pageId") ?? "").trim();
  const pageName = String(formData.get("pageName") ?? "").trim();

  if (!metaAdAccountId) return { error: "Choose an ad account." };

  const credentials = await loadMetaAdsCredentials(session.companyId);
  if (!credentials) {
    return {
      error:
        "No Meta credentials are stored for this workspace yet. Ask your platform contact to add them.",
    };
  }

  /*
   * The account is re-read from Meta rather than trusted from the form.
   *
   * The form is a request, and its currency field would decide what every
   * spend figure on the dashboard is denominated in. A tenant editing the
   * posted value could label an INR account USD - not a security boundary
   * crossing, since it is their own account, but a number on their own
   * dashboard that is wrong by a factor of eighty with nothing to say so.
   */
  const accounts = await readAdAccounts(credentials.accessToken);
  if (!accounts.ok) {
    return { error: `Meta refused the request: ${accounts.error}` };
  }

  const chosen = accounts.data.find((account) => account.id === metaAdAccountId);
  if (!chosen) {
    /* Rule 6, applied to somebody else's account: if this token cannot see it,
       it does not exist as far as this screen is concerned. */
    return { error: "That ad account is not one this connection can reach." };
  }

  /*
   * The linked-number check, made HERE and not only on the page that rendered
   * the warning. A page's check is advice; this one decides what is stored,
   * and the stored value is what the referral webhook will later be matched
   * against. Doing it only at render time would let a stale form post a Page
   * whose link changed in between.
   */
  const link = pageId
    ? await readPageWhatsAppLink(pageId, credentials.accessToken)
    : null;

  if (link && !link.ok) {
    return { error: `Meta refused the Page lookup: ${link.error}` };
  }

  const ownNumbers = await withCompany(session.companyId, (db, companyId) =>
    whatsappNumbersForMatching(db, companyId),
  );

  const verdict = checkLinkedNumber(
    link?.ok ? link.data.phoneNumber : null,
    ownNumbers,
  );

  const stored = await withCompany(session.companyId, (db, companyId) =>
    selectAdAccount(db, companyId, {
      integrationId: credentials.integrationId,
      metaAdAccountId: chosen.id,
      name: chosen.name,
      currency: chosen.currency,
      timezoneName: chosen.timezoneName,
      accountStatus: chosen.accountStatus,
      pageId: pageId || null,
      pageName: pageName || null,
      whatsappNumberId: verdict.kind === "matched" ? verdict.whatsappNumberId : null,
      linkedPhoneE164:
        verdict.kind === "matched"
          ? verdict.displayNumber
          : verdict.kind === "elsewhere"
            ? verdict.linkedPhoneE164
            : null,
    }),
  );

  /*
   * The schedule is registered AFTER the row exists, and it carries the
   * company id the worker will open its scope with.
   *
   * That is rule 3's third origin: this process took the company id from a
   * session, and the worker takes it from the payload having never seen a
   * request. The whole guarantee is about who enqueued, and the answer here is
   * a server action behind requireSession().
   */
  await registerInsightsSync(session.companyId, stored.id);

  /* Mutates and does not redirect, so it revalidates the route it changed -
     otherwise the list keeps its old contents until something else happens to
     re-render, which reads as a save that did not work. */
  revalidatePath("/meta-ads");

  return {
    notice:
      verdict.kind === "matched"
        ? `${chosen.name} is connected. Replies will arrive on ${verdict.displayNumber}.`
        : `${chosen.name} is connected, but its Page does not route replies to one of your numbers - see the warning on the account.`,
  };
}

export async function removeAdAccountAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Nothing to remove." };

  const removed = await withCompany(session.companyId, (db, companyId) =>
    removeAdAccount(db, companyId, id),
  );

  if (removed > 0) {
    /*
     * Unregistered, or the schedule wakes for ever against a row that is gone.
     * The job itself tolerates that - it returns "account_removed" rather than
     * throwing, because this call and the next tick can race - but a schedule
     * nothing will ever satisfy is a log line every six hours, permanently.
     */
    await systemQueue
      .removeJobScheduler(metaInsightsSchedulerId(id))
      .catch(() => {
        /* Best effort. A queue that is unreachable must not turn a completed
           removal into an error the tenant has to act on: the row is gone, and
           the tick that finds it missing does nothing. */
      });
  }

  /*
   * Zero rows is not an error the tenant should see as one. Under RLS a row
   * belonging to another company is simply not there, and saying "not found"
   * for both cases is rule 6 - a message that distinguished them would confirm
   * the row exists.
   */
  revalidatePath("/meta-ads");

  return removed > 0
    ? { notice: "Ad account removed. Spend already recorded for it is removed too." }
    : { error: "That ad account is no longer connected." };
}

/* ==========================================================================
   Campaigns
   ========================================================================== */

const OBJECTIVES = new Set<MetaCampaignObjectiveName>([
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_SALES",
]);

/**
 * Create a campaign. It lands PAUSED, and nothing here can ask for otherwise.
 *
 * ---------------------------------------------------------------------------
 * The order of the two writes, and why it is this way round
 * ---------------------------------------------------------------------------
 *
 * Meta first, then our row. A row written first would be a promise the network
 * might not keep: the list would show a campaign that does not exist, and the
 * publish button beside it would fail against an id Meta has never heard of.
 *
 * The other order has a failure too - Meta creates it, our write fails, and a
 * PAUSED campaign exists at Meta that this system does not know about. That is
 * strictly the better one to be left with. It spends nothing, it is visible in
 * Meta's own tools, and re-running the form produces a second paused campaign
 * rather than a second spending one.
 */
export async function createCampaignAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const adAccountId = String(formData.get("adAccountId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  const budgetRaw = String(formData.get("dailyBudget") ?? "");

  if (!name) return { error: "Give the campaign a name." };
  if (!OBJECTIVES.has(objective as MetaCampaignObjectiveName)) {
    return { error: "Choose what the campaign is for." };
  }

  const account = await withCompany(session.companyId, (db, companyId) =>
    findAdAccount(db, companyId, adAccountId),
  );

  /* Rule 6. An account belonging to another company is not found, never
     refused - a 403 would confirm the row exists. */
  if (!account) return { error: "That ad account is no longer connected." };

  /*
   * The currency is the ACCOUNT'S, read from our row, never from the form. A
   * budget denominated by a posted field is a number the tenant can mislabel
   * on their own dashboard, by a factor of eighty, with nothing to say so.
   */
  const budget = parseDailyBudget(budgetRaw, account.currency);
  if (!budget.ok) return { error: budget.error };

  const credentials = await loadMetaAdsCredentials(session.companyId);
  if (!credentials) {
    return { error: "No Meta credentials are stored for this workspace." };
  }

  const created = await createPausedCampaign(
    {
      adAccountId: account.metaAdAccountId,
      name,
      objective: objective as MetaCampaignObjectiveName,
      dailyBudgetMicros: budget.micros,
    },
    credentials.accessToken,
  );

  if (!created.ok) return { error: `Meta refused the campaign: ${created.error}` };

  await withCompany(session.companyId, (db, companyId) =>
    recordCampaign(db, companyId, {
      adAccountId: account.id,
      metaCampaignId: created.data.id,
      name,
      objective: objective as MetaCampaignObjectiveName,
      dailyBudgetMicros: budget.micros,
      currency: account.currency,
    }),
  );

  revalidatePath("/meta-ads");

  return {
    notice: `${name} was created and is PAUSED. It will not spend anything until you publish it.`,
  };
}

/**
 * Publish: the deliberate act that lets a campaign spend.
 *
 * Separated from creation, and it asks for the campaign's name to be typed. A
 * confirm step protects against a misclick; only the typed name protects
 * against publishing the wrong campaign off a list of six. That is the same
 * reasoning the KYC erasure control uses, for the same reason - the thing on
 * the other side of the button cannot be recalled.
 *
 * Meta first, again. Flipping our row first would leave a campaign this system
 * reports as ACTIVE while Meta has it paused, and the tenant waiting for
 * delivery that is never coming.
 */
export async function publishCampaignAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const id = String(formData.get("id") ?? "").trim();
  const typed = String(formData.get("confirmName") ?? "").trim();

  const campaign = await withCompany(session.companyId, (db, companyId) =>
    findCampaign(db, companyId, id),
  );

  if (!campaign) return { error: "That campaign is no longer here." };

  if (typed !== campaign.name) {
    return {
      error: `Type the campaign's name exactly - ${campaign.name} - to confirm you are starting its spend.`,
    };
  }

  const credentials = await loadMetaAdsCredentials(session.companyId);
  if (!credentials) {
    return { error: "No Meta credentials are stored for this workspace." };
  }

  const result = await setCampaignStatus(
    campaign.metaCampaignId,
    "ACTIVE",
    credentials.accessToken,
  );

  if (!result.ok) return { error: `Meta refused the change: ${result.error}` };

  await withCompany(session.companyId, (db, companyId) =>
    publishCampaign(db, companyId, id, session.userId, new Date()),
  );

  revalidatePath("/meta-ads");

  return { notice: `${campaign.name} is live and spending.` };
}

/** Pause a live campaign. No typed confirmation: stopping spend is safe. */
export async function pauseCampaignAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const id = String(formData.get("id") ?? "").trim();

  const campaign = await withCompany(session.companyId, (db, companyId) =>
    findCampaign(db, companyId, id),
  );

  if (!campaign) return { error: "That campaign is no longer here." };

  const credentials = await loadMetaAdsCredentials(session.companyId);
  if (!credentials) {
    return { error: "No Meta credentials are stored for this workspace." };
  }

  const result = await setCampaignStatus(
    campaign.metaCampaignId,
    "PAUSED",
    credentials.accessToken,
  );

  if (!result.ok) return { error: `Meta refused the change: ${result.error}` };

  await withCompany(session.companyId, (db, companyId) =>
    pauseCampaign(db, companyId, id),
  );

  revalidatePath("/meta-ads");

  /*
   * published_at is deliberately NOT cleared. "Has this ever run" is a
   * different question from "is it running now", and a report answering the
   * first from the current status would say no for every campaign anybody has
   * ever paused.
   */
  return {
    notice: `${campaign.name} is paused. It will not spend again until you publish it.`,
  };
}
