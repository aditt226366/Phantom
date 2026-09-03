import { graphGetQuery, graphPost, type GraphResult } from "./meta.ts";
import type { FetchImpl } from "./types.ts";

/**
 * The Meta Marketing API, as far as this product uses it.
 *
 * Everything here runs on the TENANT'S own access token - amendment A3 - so
 * there is no app-level credential anywhere in this file and no call that
 * reaches across tenants. The token arrives from the vault, scoped to one
 * company, and every function takes it as an argument rather than reading it
 * from anywhere.
 *
 * Failures come back as VerificationFailure through GraphResult, decoded by
 * the one decoder in meta.ts: auth demotes the badge, config demotes it,
 * transient does not. Nothing in this file classifies an error itself.
 */

/* ==========================================================================
   Money
   ========================================================================== */

/**
 * Micros per minor unit. 1 rupee = 100 paise = 1,000,000 micros.
 *
 * Meta talks in minor units as integer strings; this system stores micros,
 * like every other cost column. The factor is a constant rather than a literal
 * at two call sites because getting it wrong in one direction is a budget a
 * hundred times too large.
 */
const MICROS_PER_MINOR_UNIT = 10_000n;

/**
 * Meta's decimal spend string to micros, without going through a float.
 *
 * Their insights return `"spend": "1234.56"` - a decimal string, in the
 * account's currency, with a number of places that depends on the currency
 * (JPY has none, KWD has three). Number() would be correct for small values
 * and would start losing digits somewhere above nine billion micros, silently
 * and only for the accounts that spend the most.
 *
 * So it is parsed as text: split on the point, pad or truncate the fraction to
 * six places, and concatenate. No arithmetic on anything that is not a bigint.
 *
 * Returns null rather than throwing for anything unparseable. Meta has
 * returned an empty string for a day with no delivery, and a whole sync must
 * not fail because one row of twenty-eight had nothing in it.
 */
export function spendToMicros(spend: string): bigint | null {
  const text = spend.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  /* Six places exactly: pad a short fraction, drop anything beyond. Meta does
     not report sub-micro amounts, so the truncation is unreachable in
     practice and is written rather than assumed. */
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));

  return negative ? -micros : micros;
}

/**
 * Micros to the integer minor units Meta's budget fields take.
 *
 * Exact or nothing. A budget of 1,234,567 micros is 123.4567 paise, which Meta
 * cannot express, and the two ways to handle that are both worse than
 * refusing: rounding down spends less than the tenant asked for and rounding up
 * spends more than they authorised. The builder only ever produces whole minor
 * units, so this throwing means a caller composed something it should not have.
 */
export function minorUnitsFromMicros(micros: bigint): string {
  if (micros % MICROS_PER_MINOR_UNIT !== 0n) {
    throw new Error(
      `${micros} micros is not a whole minor unit and Meta cannot express it`,
    );
  }
  return (micros / MICROS_PER_MINOR_UNIT).toString();
}

/* ==========================================================================
   Reading what the tenant has
   ========================================================================== */

export interface MetaAdAccountSummary {
  /** With the act_ prefix, as Meta returns it and as every path needs it. */
  id: string;
  name: string;
  currency: string;
  timezoneName: string | null;
  /** Meta's numeric account state. 1 is active; 2, 3, 7, 8 and 9 are not. */
  accountStatus: number | null;
}

interface GraphList<T> {
  data?: T[];
}

/**
 * The ad accounts this token can reach.
 *
 * `me/adaccounts` rather than a business-scoped listing, because the token is
 * the tenant's and "what can this credential see" is exactly the question the
 * selection screen is asking. A token that reaches one account lists one.
 */
export async function listAdAccounts(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<MetaAdAccountSummary[]>> {
  const result = await graphGetQuery<
    GraphList<{
      id?: string;
      name?: string;
      currency?: string;
      timezone_name?: string;
      account_status?: number;
    }>
  >(
    "me/adaccounts",
    { fields: "id,name,currency,timezone_name,account_status", limit: "100" },
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  const accounts: MetaAdAccountSummary[] = [];
  for (const row of result.data.data ?? []) {
    /* An account with no id or no currency is not selectable: the id is every
       path and the currency is what stops spend being summed across accounts.
       Skipped rather than defaulted - a made-up currency is worse than an
       account that does not appear. */
    if (!row.id || !row.currency) continue;
    accounts.push({
      id: row.id,
      name: row.name ?? row.id,
      currency: row.currency,
      timezoneName: row.timezone_name ?? null,
      accountStatus: row.account_status ?? null,
    });
  }

  return { ok: true, statusCode: result.statusCode, data: accounts };
}

export interface MetaPageSummary {
  id: string;
  name: string;
}

/** The Pages this token administers. A CTWA ad posts from one of them. */
export async function listPages(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<MetaPageSummary[]>> {
  const result = await graphGetQuery<GraphList<{ id?: string; name?: string }>>(
    "me/accounts",
    { fields: "id,name", limit: "100" },
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  const pages: MetaPageSummary[] = [];
  for (const row of result.data.data ?? []) {
    if (!row.id) continue;
    pages.push({ id: row.id, name: row.name ?? row.id });
  }

  return { ok: true, statusCode: result.statusCode, data: pages };
}

export interface PageWhatsAppLink {
  /** The number Meta says this Page routes click-to-WhatsApp traffic to. */
  phoneNumber: string | null;
  /** The WhatsApp Business Account behind it, when Meta names one. */
  wabaId: string | null;
}

/**
 * Which WhatsApp number a Page is linked to.
 *
 * This is the whole of the linked-number validation, and it is worth being
 * clear about what it can and cannot establish. Meta answers with the number
 * the Page is connected to; we compare it against the numbers this tenant has
 * configured. A match means an ad from this Page lands in an inbox we can see.
 * A mismatch is NOT an error - an agency running ads for a business whose
 * WhatsApp lives elsewhere is a real arrangement - it means the referral
 * attribution will never fire, and the tenant should be told that before they
 * spend money rather than after.
 *
 * Both fields are optional in the response and both come back null when
 * absent. A Page with no WhatsApp connection at all answers `{}` here, which
 * is a legitimate state and not a failure.
 */
export async function pageWhatsAppLink(
  pageId: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<PageWhatsAppLink>> {
  const result = await graphGetQuery<{
    whatsapp_number?: string;
    connected_whatsapp_business_account?: { id?: string };
  }>(
    pageId,
    { fields: "whatsapp_number,connected_whatsapp_business_account" },
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  return {
    ok: true,
    statusCode: result.statusCode,
    data: {
      phoneNumber: result.data.whatsapp_number ?? null,
      wabaId: result.data.connected_whatsapp_business_account?.id ?? null,
    },
  };
}

/* ==========================================================================
   Writing
   ========================================================================== */

export type MetaCampaignObjectiveName =
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_SALES";

export interface CreateCampaignInput {
  /** With the act_ prefix. */
  adAccountId: string;
  name: string;
  objective: MetaCampaignObjectiveName;
  /** Micros of the ad account's own currency. Optional: Meta allows none. */
  dailyBudgetMicros?: bigint;
}

/**
 * Create a campaign, PAUSED, and there is deliberately no way to ask for
 * anything else.
 *
 * `status: "PAUSED"` is not a default this function accepts an override for -
 * it is written into the body and the input type has no field for it. A
 * caller that wants a campaign running has to create it and then publish it,
 * which is a second deliberate act by somebody who has seen what was created.
 *
 * That is the second of the two mechanisms; the first is the column default in
 * the database. Either alone is a single point of failure, and only one of
 * them is ours - Meta's API would happily take ACTIVE from a caller that
 * passed it.
 *
 * `special_ad_categories` is required by Meta on every create and an empty
 * array is the correct value for ordinary commerce. Omitting it is a 400 that
 * reads like a permissions problem.
 */
export async function createPausedCampaign(
  input: CreateCampaignInput,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<{ id: string }>> {
  const body: Record<string, unknown> = {
    name: input.name,
    objective: input.objective,
    status: "PAUSED",
    special_ad_categories: [],
  };

  if (input.dailyBudgetMicros !== undefined) {
    body["daily_budget"] = minorUnitsFromMicros(input.dailyBudgetMicros);
  }

  const result = await graphPost<{ id?: string }>(
    `${input.adAccountId}/campaigns`,
    body,
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  if (!result.data.id) {
    /* A 200 with no id. Treated as config rather than transient: retrying an
       ambiguous create is how a tenant ends up with two campaigns, and the
       badge should say something is wrong. */
    return {
      ok: false,
      kind: "config",
      statusCode: result.statusCode,
      error: "Meta accepted the campaign but returned no id.",
    };
  }

  return { ok: true, statusCode: result.statusCode, data: { id: result.data.id } };
}

/** Turn a campaign on or off at Meta. The local row is written separately. */
export async function setCampaignStatus(
  metaCampaignId: string,
  status: "ACTIVE" | "PAUSED" | "ARCHIVED",
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<unknown>> {
  return graphPost(metaCampaignId, { status }, accessToken, [accessToken], fetchImpl);
}

/* ==========================================================================
   Insights
   ========================================================================== */

export interface DailyCampaignSpend {
  metaCampaignId: string;
  campaignName: string | null;
  /** YYYY-MM-DD in the ad account's own timezone, as Meta reports it. */
  date: string;
  impressions: bigint;
  clicks: bigint;
  spendMicros: bigint;
}

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  return /^\d+$/.test(value.trim()) ? BigInt(value.trim()) : 0n;
}

/**
 * A campaign-level, day-by-day breakdown for one account.
 *
 * `time_increment: 1` is what makes a row a DAY rather than a total for the
 * range, and it is the whole reason the sync can be idempotent: a day is a
 * stable key that can be re-read and overwritten. Without it a re-sync would
 * produce one row covering a moving window, and there would be nothing to
 * update it against.
 *
 * The dates Meta returns are in the AD ACCOUNT'S timezone, not ours, and are
 * stored as given. Re-interpreting them against a platform day at +05:30 would
 * move spend between days on every run, which looks like a reconciliation
 * problem and is a timezone one.
 */
export async function campaignInsights(
  adAccountId: string,
  since: string,
  until: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GraphResult<DailyCampaignSpend[]>> {
  const result = await graphGetQuery<
    GraphList<{
      campaign_id?: string;
      campaign_name?: string;
      date_start?: string;
      impressions?: string;
      clicks?: string;
      spend?: string;
    }>
  >(
    `${adAccountId}/insights`,
    {
      level: "campaign",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: "campaign_id,campaign_name,impressions,clicks,spend",
      limit: "500",
    },
    accessToken,
    [accessToken],
    fetchImpl,
  );

  if (!result.ok) return result;

  const days: DailyCampaignSpend[] = [];
  for (const row of result.data.data ?? []) {
    /* Without a campaign id and a day there is no key to write the row under,
       so it is dropped rather than stored where nothing can update it. */
    if (!row.campaign_id || !row.date_start) continue;

    days.push({
      metaCampaignId: row.campaign_id,
      campaignName: row.campaign_name ?? null,
      date: row.date_start,
      impressions: toBigInt(row.impressions),
      clicks: toBigInt(row.clicks),
      /* A day Meta reports with no spend field is a day with no delivery, and
         zero is the honest figure for it. */
      spendMicros: spendToMicros(row.spend ?? "0") ?? 0n,
    });
  }

  return { ok: true, statusCode: result.statusCode, data: days };
}
