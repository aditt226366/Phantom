import type { CompanyClient } from "./with-company.ts";

/**
 * Ad accounts, campaigns, spend and the clicks that arrived.
 *
 * Every function here takes an already-scoped client. The company id comes
 * from the caller's `withCompany`, which took it from a session or a job
 * payload - never from a request. Rule 3.
 *
 * ---------------------------------------------------------------------------
 * Nothing in this file sums two currencies, and nothing may start
 * ---------------------------------------------------------------------------
 *
 * There is no exchange rate in this system. A tenant running one account in
 * INR and another in USD has two spend figures and no total, and the shape
 * that enforces it is the return type: `spendThisMonth` answers a Map keyed by
 * currency, never a number. A single numeric column invites a component
 * written in a hurry to add 4,000 to 50 and render 4,050 of nothing with
 * exactly the authority of a correct figure.
 *
 * The same rule the dashboard already follows for usage spend.
 */

export interface AdAccountRow {
  id: string;
  metaAdAccountId: string;
  name: string;
  currency: string;
  timezoneName: string | null;
  accountStatus: number | null;
  pageId: string | null;
  pageName: string | null;
  whatsappNumberId: string | null;
  linkedPhoneE164: string | null;
  insightsSyncedThrough: Date | null;
  insightsSyncedAt: Date | null;
  createdAt: Date;
}

/** Every ad account this company has selected. */
export async function listAdAccountRows(
  db: CompanyClient,
  companyId: string,
): Promise<AdAccountRow[]> {
  return db.metaAdAccount.findMany({
    where: { companyId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      metaAdAccountId: true,
      name: true,
      currency: true,
      timezoneName: true,
      accountStatus: true,
      pageId: true,
      pageName: true,
      whatsappNumberId: true,
      linkedPhoneE164: true,
      insightsSyncedThrough: true,
      insightsSyncedAt: true,
      createdAt: true,
    },
  });
}

export interface SelectAdAccountInput {
  integrationId: string;
  metaAdAccountId: string;
  name: string;
  currency: string;
  timezoneName: string | null;
  accountStatus: number | null;
  pageId: string | null;
  pageName: string | null;
  /** Our row for the number Meta says the Page is linked to, when we own it. */
  whatsappNumberId: string | null;
  /** What Meta reported, whether or not we own it. */
  linkedPhoneE164: string | null;
}

/**
 * Select an ad account, or update the one already selected.
 *
 * An upsert on (company_id, meta_ad_account_id), so re-running the selection
 * screen after changing the Page updates the row rather than failing or
 * duplicating it. Duplicating would be worse than failing: the insights sync
 * runs per row, so two rows for one account write every day's spend twice
 * under different ids and the month reads double.
 *
 * `insightsSyncedThrough` is deliberately NOT touched here. Re-selecting an
 * account to fix its Page must not re-read a year of history, and clearing the
 * cursor is how that happens.
 */
export async function selectAdAccount(
  db: CompanyClient,
  companyId: string,
  input: SelectAdAccountInput,
): Promise<{ id: string }> {
  return db.metaAdAccount.upsert({
    where: {
      companyId_metaAdAccountId: {
        companyId,
        metaAdAccountId: input.metaAdAccountId,
      },
    },
    create: { companyId, ...input },
    update: {
      name: input.name,
      currency: input.currency,
      timezoneName: input.timezoneName,
      accountStatus: input.accountStatus,
      pageId: input.pageId,
      pageName: input.pageName,
      whatsappNumberId: input.whatsappNumberId,
      linkedPhoneE164: input.linkedPhoneE164,
    },
    select: { id: true },
  });
}

export async function findAdAccount(
  db: CompanyClient,
  companyId: string,
  id: string,
): Promise<AdAccountRow | null> {
  /*
   * findFirst rather than findUnique, so a row belonging to another company is
   * NOT FOUND rather than found-and-refused. Rule 6: a 403 confirms the row
   * exists, and if it is not yours it does not exist.
   */
  return db.metaAdAccount.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      metaAdAccountId: true,
      name: true,
      currency: true,
      timezoneName: true,
      accountStatus: true,
      pageId: true,
      pageName: true,
      whatsappNumberId: true,
      linkedPhoneE164: true,
      insightsSyncedThrough: true,
      insightsSyncedAt: true,
      createdAt: true,
    },
  });
}

export async function removeAdAccount(
  db: CompanyClient,
  companyId: string,
  id: string,
): Promise<number> {
  const { count } = await db.metaAdAccount.deleteMany({ where: { id, companyId } });
  return count;
}

/* ==========================================================================
   Campaigns
   ========================================================================== */

export interface CampaignRow {
  id: string;
  adAccountId: string;
  metaCampaignId: string;
  name: string;
  objective: string;
  status: string;
  dailyBudgetMicros: bigint | null;
  currency: string;
  publishedAt: Date | null;
  createdAt: Date;
}

const CAMPAIGN_FIELDS = {
  id: true,
  adAccountId: true,
  metaCampaignId: true,
  name: true,
  objective: true,
  status: true,
  dailyBudgetMicros: true,
  currency: true,
  publishedAt: true,
  createdAt: true,
} as const;

export async function listCampaigns(
  db: CompanyClient,
  companyId: string,
  limit = 50,
): Promise<CampaignRow[]> {
  return db.metaCampaign.findMany({
    where: { companyId },
    /* `id` last, because created_at ties are the normal case here and not the
       exotic one - and with a `take` a tie decides which rows are in the
       answer at all. See total-ordering.test.ts. */
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit,
    select: CAMPAIGN_FIELDS,
  });
}

export async function findCampaign(
  db: CompanyClient,
  companyId: string,
  id: string,
): Promise<CampaignRow | null> {
  return db.metaCampaign.findFirst({
    where: { id, companyId },
    select: CAMPAIGN_FIELDS,
  });
}

export interface RecordCampaignInput {
  adAccountId: string;
  metaCampaignId: string;
  name: string;
  objective: "OUTCOME_ENGAGEMENT" | "OUTCOME_LEADS" | "OUTCOME_TRAFFIC" | "OUTCOME_SALES";
  dailyBudgetMicros: bigint | null;
  currency: string;
}

/**
 * Record a campaign Meta has already created.
 *
 * Called AFTER the Graph call succeeds, never before: a row here means a
 * campaign exists at Meta, and a row written first would be a promise the
 * network might not keep.
 *
 * `status` is not a parameter. The column defaults to PAUSED and this function
 * offers no way to say otherwise, which is the same refusal
 * `createPausedCampaign` makes at the Graph boundary. Two mechanisms, and
 * neither is a default a caller can override by passing the wrong thing.
 */
export async function recordCampaign(
  db: CompanyClient,
  companyId: string,
  input: RecordCampaignInput,
): Promise<CampaignRow> {
  return db.metaCampaign.create({
    data: { companyId, ...input },
    select: CAMPAIGN_FIELDS,
  });
}

/**
 * Publish a campaign: the deliberate act that lets it spend.
 *
 * The instant and the person are written in the same statement that changes
 * the status, because the CHECK refuses an ACTIVE row with no published_at -
 * and because "who started this spending and when" is the first question asked
 * about an ad bill.
 *
 * `publishedAt` is set with COALESCE semantics by being written only when it
 * is currently null: re-publishing a campaign that was paused and restarted
 * keeps the original instant, which is what "has this ever run" means.
 */
export async function publishCampaign(
  db: CompanyClient,
  companyId: string,
  id: string,
  userId: string,
  now: Date,
): Promise<CampaignRow | null> {
  const existing = await db.metaCampaign.findFirst({
    where: { id, companyId },
    select: { id: true, publishedAt: true },
  });
  if (!existing) return null;

  const rows = await db.metaCampaign.updateManyAndReturn({
    where: { id, companyId },
    data: {
      status: "ACTIVE",
      publishedAt: existing.publishedAt ?? now,
      publishedByUserId: userId,
    },
    select: CAMPAIGN_FIELDS,
  });

  return rows[0] ?? null;
}

/** Pause a campaign. Does not clear publishedAt - see publishCampaign. */
export async function pauseCampaign(
  db: CompanyClient,
  companyId: string,
  id: string,
): Promise<CampaignRow | null> {
  const rows = await db.metaCampaign.updateManyAndReturn({
    where: { id, companyId },
    data: { status: "PAUSED" },
    select: CAMPAIGN_FIELDS,
  });

  return rows[0] ?? null;
}

/* ==========================================================================
   Spend
   ========================================================================== */

export interface DailySpendInput {
  adAccountId: string;
  metaCampaignId: string;
  campaignName: string | null;
  /** The advertising day in the ad account's timezone, as Meta reported it. */
  date: Date;
  impressions: bigint;
  clicks: bigint;
  spendMicros: bigint;
  currency: string;
}

/**
 * Write one day's figures, replacing whatever was there.
 *
 * An upsert on the day, which is what makes the sync idempotent. Meta restates
 * recent days as attribution windows close, so a nightly run re-reads the same
 * 28 days every night; without this the month reads at 28 times the truth, and
 * it reads it as an ordinary number on a page where everything else is right.
 */
export async function recordDailySpend(
  db: CompanyClient,
  companyId: string,
  input: DailySpendInput,
): Promise<void> {
  await db.metaAdInsight.upsert({
    where: {
      companyId_adAccountId_metaCampaignId_date: {
        companyId,
        adAccountId: input.adAccountId,
        metaCampaignId: input.metaCampaignId,
        date: input.date,
      },
    },
    create: { companyId, ...input },
    update: {
      campaignName: input.campaignName,
      impressions: input.impressions,
      clicks: input.clicks,
      spendMicros: input.spendMicros,
      currency: input.currency,
      syncedAt: new Date(),
    },
  });
}

/** How far the sync has read for this account. */
export async function markInsightsSynced(
  db: CompanyClient,
  companyId: string,
  adAccountId: string,
  through: Date,
  now: Date,
): Promise<void> {
  await db.metaAdAccount.updateMany({
    where: { id: adAccountId, companyId },
    data: { insightsSyncedThrough: through, insightsSyncedAt: now },
  });
}

/**
 * Spend between two days, per currency.
 *
 * A Map and never a total. The values are bigint micros; a caller that wants
 * to render one converts at the last moment and never adds two entries
 * together. See the header.
 *
 * `unpriced` has no analogue here and is deliberately absent: every insight
 * row carries a currency because Meta always reports one, so there is no
 * "spend we could not denominate" bucket to keep separate.
 */
export async function spendByCurrency(
  db: CompanyClient,
  companyId: string,
  from: Date,
  to: Date,
): Promise<Map<string, bigint>> {
  const grouped = await db.metaAdInsight.groupBy({
    by: ["currency"],
    where: { companyId, date: { gte: from, lte: to } },
    _sum: { spendMicros: true },
  });

  const out = new Map<string, bigint>();
  for (const row of grouped) {
    /* Consumed as a lookup, never rendered in sequence, so the absence of an
       order here is correct rather than an oversight - see the conventions on
       groupBy. A page that lists currencies sorts them itself. */
    out.set(row.currency, row._sum.spendMicros ?? 0n);
  }

  return out;
}

/* ==========================================================================
   The clicks that arrived
   ========================================================================== */

export interface ReferralInput {
  conversationId: string;
  contactId: string;
  messageId: string;
  ctwaClid: string | null;
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  occurredAt: Date;
}

/**
 * Record a click-to-WhatsApp referral, once per message.
 *
 * `createMany` with `skipDuplicates` rather than a check-then-insert. Meta
 * redelivers any webhook it did not get a 200 for, and the redelivery carries
 * the same referral block - so the question is not whether a duplicate will
 * arrive but what happens when it does. A check-then-insert has a window
 * between the question and the answer, which two concurrent deliveries of the
 * same message will find.
 *
 * Returns whether a row was actually written, so the caller can stamp the
 * contact's source exactly once and skip the work on a redelivery.
 */
export async function recordReferral(
  db: CompanyClient,
  companyId: string,
  input: ReferralInput,
): Promise<boolean> {
  const { count } = await db.metaAdReferral.createMany({
    data: [{ companyId, ...input }],
    skipDuplicates: true,
  });

  return count > 0;
}

/**
 * How many people each ad brought, over a window.
 *
 * The join between money and leads, and it is a count of CONVERSATIONS rather
 * than of referrals: a referral is one per message and a contact who clicks the
 * same ad twice is one lead, not two.
 */
export async function leadsByAd(
  db: CompanyClient,
  companyId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const grouped = await db.metaAdReferral.groupBy({
    by: ["sourceId"],
    where: { companyId, occurredAt: { gte: from, lte: to }, sourceId: { not: null } },
    _count: { _all: true },
  });

  const out = new Map<string, number>();
  for (const row of grouped) {
    if (row.sourceId) out.set(row.sourceId, row._count._all);
  }

  return out;
}

/**
 * Where this company's contacts came from.
 *
 * Null is its own bucket and is returned under the key `unrecorded`, not
 * folded into INBOUND. Every contact predating Phase 10 has null because
 * nothing was recording it, and counting them as organic arrivals would tell a
 * tenant something false about their own business on a page where every other
 * figure is true.
 */
export async function contactsBySource(
  db: CompanyClient,
  companyId: string,
): Promise<Map<string, number>> {
  const grouped = await db.contact.groupBy({
    by: ["source"],
    where: { companyId },
    _count: { _all: true },
  });

  const out = new Map<string, number>();
  for (const row of grouped) {
    out.set(row.source ?? "unrecorded", row._count._all);
  }

  return out;
}

/* ==========================================================================
   Credentials
   ========================================================================== */

export interface SealedIntegration {
  integrationId: string;
  secrets: { key: string; ciphertext: string }[];
}

/**
 * The tenant's own Meta Ads credentials, still sealed.
 *
 * Sealed, because decryption belongs OUTSIDE the withCompany scope: this holds
 * a pooled connection with a five-second budget, and everything the caller
 * does with these values is a Graph call. The same split the send path makes.
 *
 * Null when the company has no Meta Ads integration at all, which is the
 * ordinary state before somebody connects one and is not an error.
 */
export async function metaAdsCredentials(
  db: CompanyClient,
  companyId: string,
): Promise<SealedIntegration | null> {
  const integration = await db.integration.findFirst({
    where: { companyId, provider: "META_ADS" },
    select: { id: true, secrets: { select: { key: true, ciphertext: true } } },
  });

  if (!integration) return null;

  return { integrationId: integration.id, secrets: integration.secrets };
}

/**
 * The company's own WhatsApp numbers, for matching against a Page's link.
 *
 * Both forms, because Meta reports whichever the Page carries and they are not
 * always the same string: `display_number` is what a person recognises and
 * `phone_number_id` is what the Graph API uses.
 */
export async function whatsappNumbersForMatching(
  db: CompanyClient,
  companyId: string,
): Promise<{ id: string; displayNumber: string; verifiedName: string | null }[]> {
  return db.whatsAppNumber.findMany({
    where: { companyId },
    orderBy: [{ displayNumber: "asc" }, { id: "asc" }],
    select: { id: true, displayNumber: true, verifiedName: true },
  });
}
