import {
  decrypt,
  secretAad,
  usageDedupeKey,
  type WhatsAppNumbersRefreshJob,
} from "@whatsapp-os/core";
import { fetchWhatsAppNumbers } from "@whatsapp-os/core/whatsapp";
import { applyNumberRefresh, recordUsage, withCompany } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Keep a number's quality rating and messaging tier current.
 *
 * Everything on whatsapp_numbers below the id is a cache of state that lives at
 * Meta and changes without telling us. This job is the only thing that refills
 * it, and it runs from three places:
 *
 *   a person pressing Refresh on the numbers page
 *   a successful integration verification, which is when credentials are known
 *     good and the cache is most likely to be empty
 *   the phone_number_quality_update webhook, where Meta tells us something
 *     changed but not reliably what
 *
 * Never on page load. A Graph call on every dashboard render is exactly what
 * the cache exists to prevent, so the page reads metadata_refreshed_at and says
 * how old the answer is instead of going to get a new one.
 *
 * Idempotent by construction - it reads Meta and overwrites a cache - so it
 * keeps the default five attempts. The send job takes exactly one for the
 * opposite reason: a repeated send reaches a real customer twice.
 */

export async function handleWhatsAppNumbersRefresh(
  payload: WhatsAppNumbersRefreshJob,
  jobId: string,
): Promise<{ integrations: number; refreshed: number; missing: number }> {
  const { companyId } = payload;

  /* 1. Read the credentials. */
  const integrations = await withCompany(companyId, (db) =>
    db.integration.findMany({
      where: { provider: "WHATSAPP_CLOUD" },
      select: {
        id: true,
        secrets: { select: { key: true, ciphertext: true } },
      },
    }),
  );

  let refreshed = 0;
  let missing = 0;

  for (const integration of integrations) {
    /* 2. Decrypt and call. No company scope is open across this. */
    const secrets: Record<string, string> = {};
    for (const row of integration.secrets) {
      secrets[row.key] = decrypt(
        row.ciphertext,
        keyring(),
        secretAad(companyId, integration.id, row.key),
      );
    }

    const result = await fetchWhatsAppNumbers(secrets);

    if (!result.ok) {
      /*
       * Thrown, so the job retries and a durable failure lands in the failed
       * queue. Nothing is written on the way past: a failed read says nothing
       * about which numbers exist, and marking every number missing because one
       * call timed out is precisely the mistake applyNumberRefresh is built to
       * avoid.
       */
      throw new Error(
        `Could not read numbers for integration ${integration.id} ` +
          `(${result.kind}): ${result.error}`,
      );
    }

    /* 3. Write, and record the call. */
    const now = new Date();

    const counts = await withCompany(companyId, async (db, scoped) => {
      const applied = await applyNumberRefresh(
        db,
        scoped,
        integration.id,
        result.numbers,
        now,
      );

      /*
       * The job id, not a timestamp. Every one of the five attempts carries the
       * same id, so one Graph call is charged once however many attempts it
       * took to record - the pattern integration.verify established.
       */
      await recordUsage(db, scoped, {
        kind: "whatsapp.numbers.refresh",
        dedupeKey: usageDedupeKey("whatsapp.numbers.refresh", jobId, integration.id),
      });

      return applied;
    });

    refreshed += counts.refreshed;
    missing += counts.missing;

    log.info("numbers refreshed", {
      companyId,
      integrationId: integration.id,
      ...counts,
    });

    if (counts.missing > 0) {
      /*
       * Its own line, at warn, because it is the one outcome a person may need
       * to act on - and the action is theirs: the row is marked, never removed.
       */
      log.warn("numbers Meta no longer returns", {
        companyId,
        integrationId: integration.id,
        missing: counts.missing,
      });
    }
  }

  return { integrations: integrations.length, refreshed, missing };
}
