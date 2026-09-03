import {
  campaignInsights,
  decrypt,
  secretAad,
  usageDedupeKey,
  type MetaInsightsSyncJob,
} from "@whatsapp-os/core";
import {
  findAdAccount,
  markInsightsSynced,
  metaAdsCredentials,
  recordDailySpend,
  recordUsage,
  withCompany,
} from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Read one ad account's spend from Meta and store it, day by day.
 *
 * ---------------------------------------------------------------------------
 * A window, not a cursor, and that is the whole design
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is a high-water mark: remember the last day read, ask for
 * everything after it. That is wrong for this data, and wrong in a direction
 * nothing would report.
 *
 * Meta RESTATES recent days. Attribution windows close over the following days
 * and a Tuesday's spend keeps changing for most of a week. A forward-only
 * cursor keeps the first figure it ever saw for every day - and the first
 * figure is precisely the one most likely to be revised. The month would settle
 * on a number that was never right and would never be corrected.
 *
 * So each run re-reads a window ending today, and each day is UPSERTED on
 * (company, account, campaign, day). The unique index is what makes that safe:
 * without it, re-reading 28 days every night multiplies every figure by 28.
 *
 * `insightsSyncedThrough` is therefore a REPORT of how far the last run read,
 * not an instruction to the next one. Nothing branches on it.
 *
 * ---------------------------------------------------------------------------
 * The day is Meta's
 * ---------------------------------------------------------------------------
 *
 * Their dates are in the ad account's own timezone. An account set to
 * America/Los_Angeles has a different Tuesday from a platform day computed at
 * +05:30, and re-interpreting the string against our boundary would move spend
 * between days on every single run - which looks like a reconciliation problem
 * and is a timezone one. The string is parsed as a UTC midnight and stored in a
 * DATE column, so it round-trips as the day Meta named.
 */

/** Meta's YYYY-MM-DD, as a DATE column value. */
function toDateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface InsightsSyncResult {
  days: number;
  /** Micros per currency. Never a total - see the db module's header. */
  spendMicros: Map<string, bigint>;
  skipped: string | null;
}

export async function handleMetaInsightsSync(
  payload: MetaInsightsSyncJob,
  now: Date = new Date(),
): Promise<InsightsSyncResult> {
  const empty: InsightsSyncResult = {
    days: 0,
    spendMicros: new Map(),
    skipped: null,
  };

  const context = await withCompany(payload.companyId, async (db, companyId) => ({
    account: await findAdAccount(db, companyId, payload.adAccountId),
    sealed: await metaAdsCredentials(db, companyId),
  }));

  if (!context.account) {
    /*
     * The account was removed while a schedule was still registered for it.
     * Not an error: it is what removal looks like from in here, and throwing
     * would retry a job that can never succeed. The scheduler is unregistered
     * by the action that removed the row; this is the tick that races it.
     */
    return { ...empty, skipped: "account_removed" };
  }

  if (!context.sealed) return { ...empty, skipped: "no_credentials" };

  const token = context.sealed.secrets.find(
    (row) => row.key === "META_ADS_ACCESS_TOKEN",
  );
  if (!token) return { ...empty, skipped: "no_token" };

  /* Decrypted OUTSIDE the withCompany scope above, like every other provider
     path here: that scope is a transaction with a five-second budget and what
     follows is a ten-second Graph timeout. */
  const accessToken = decrypt(
    token.ciphertext,
    keyring(),
    secretAad(payload.companyId, context.sealed.integrationId, token.key),
  );

  const until = isoDay(now);
  const since = isoDay(
    new Date(now.getTime() - payload.lookbackDays * 24 * 60 * 60 * 1000),
  );

  const insights = await campaignInsights(
    context.account.metaAdAccountId,
    since,
    until,
    accessToken,
  );

  if (!insights.ok) {
    /*
     * Thrown, so BullMQ retries. An auth failure will keep failing until the
     * tenant reconnects - which is exactly what the expiry banner is for - and
     * the retries are cheap. What must not happen is a silent success that
     * advances the sync marker over a window nothing was read for, because the
     * next run would then never look at those days again.
     */
    log.warn("meta.insights.sync failed", {
      companyId: payload.companyId,
      adAccountId: payload.adAccountId,
      kind: insights.kind,
      error: insights.error,
    });
    throw new Error(`Meta insights failed (${insights.kind}): ${insights.error}`);
  }

  const spendMicros = new Map<string, bigint>();

  for (const day of insights.data) {
    /*
     * The currency is the ACCOUNT'S, from our row, and not from the insight.
     * Meta reports figures for the account it was asked about, so the two
     * agree - but reading it from the response would make a malformed payload
     * able to denominate a row, and a spend row in the wrong currency is
     * invisible: the number is plausible and the label is wrong.
     */
    const currency = context.account.currency;

    await withCompany(payload.companyId, async (db, companyId) => {
      await recordDailySpend(db, companyId, {
        adAccountId: context.account!.id,
        metaCampaignId: day.metaCampaignId,
        campaignName: day.campaignName,
        date: toDateOnly(day.date),
        impressions: day.impressions,
        clicks: day.clicks,
        spendMicros: day.spendMicros,
        currency,
      });

      /*
       * One usage row per campaign-day, deduped on the same key the insight
       * row uses. A nightly re-read of the window restates both together, so
       * the two can never disagree about a day.
       *
       * The cost is NOT priced from the usage table. Every other kind there
       * records something we did and will price later; this records money the
       * tenant has already been billed by Meta, in the account's own currency,
       * and that figure lives on the insight row where it can be read per
       * currency without anything summing across them.
       */
      await recordUsage(db, companyId, {
        kind: "meta.ad.spend",
        dedupeKey: usageDedupeKey(
          "meta.ad.spend",
          context.account!.id,
          day.metaCampaignId,
          day.date,
        ),
        /* Meta's day, at its start, not the moment this job ran. A re-sync
           weeks later must land the event on the day it describes. */
        occurredAt: toDateOnly(day.date),
      });
    });

    spendMicros.set(currency, (spendMicros.get(currency) ?? 0n) + day.spendMicros);
  }

  await withCompany(payload.companyId, (db, companyId) =>
    markInsightsSynced(db, companyId, payload.adAccountId, toDateOnly(until), now),
  );

  log.info("meta.insights.sync", {
    companyId: payload.companyId,
    adAccountId: payload.adAccountId,
    days: insights.data.length,
    since,
    until,
  });

  return { days: insights.data.length, spendMicros, skipped: null };
}
