import "./_load-env.mjs";

/**
 * Recover Meta's conversation charges from webhook payloads already stored.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT HAS A DEADLINE
 * ===========================================================================
 *
 * Meta bills per 24-hour conversation window, per category, and it is the
 * largest real cost in the product. Nothing recorded a single one of them from
 * Phase 4 until the commit that added this script: `payload.ts` parsed
 * `pricing.category` and `pricing.billable` off every status callback and the
 * webhook dropped them.
 *
 * The history is not lost, though, and that is an accident. `whatsapp_webhook_events`
 * still holds every delivery ever received, verbatim, because R9's 30-day prune
 * was deferred and never built. So the entire billing history of the product is
 * sitting in a text column, reconstructable by re-parsing it.
 *
 * It stops being reconstructable the day the prune ships. That ordering is now
 * load-bearing and is written down in docs/plans/spec-amendments.md, because
 * nothing in the prune's own code would ever mention it.
 *
 *   npm run backfill:charges -- --dry-run
 *   npm run backfill:charges
 *
 * ===========================================================================
 * Safe to run twice, by construction rather than by care
 * ===========================================================================
 *
 * Every write goes through `recordConversationCharge`, the same function the
 * live webhook calls - so the two cannot come to disagree about what a status
 * callback means for the bill. It is idempotent on Meta's conversation id: the
 * charge row by its unique index, the usage row by the dedupe key. Running this
 * after the webhook has been recording live changes nothing that already
 * exists, and interrupting it half way is resumable by running it again.
 */

import { parseWebhookPayload } from "@whatsapp-os/core/whatsapp";
import { recordConversationCharge, withCompany } from "@whatsapp-os/db";

import { listStoredWebhookPayloads } from "@/lib/admin-db";

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Read in pages, ordered totally.
 *
 * `whatsapp_webhook_events` is the fastest-growing table in the system and a
 * production one will not fit in memory. Keyset pagination on the primary key,
 * which is unique - see the conventions on limited reads: `created_at` would
 * tie across a burst of deliveries and a page boundary inside the tie would
 * skip events, which here means silently missing charges.
 */
const PAGE = 500;

/* ------------------------------------------------------------------------- *
 * The sweep
 * ------------------------------------------------------------------------- */

let cursor;
let events = 0;
let statuses = 0;
let windows = 0;
let charged = 0;
let unparseable = 0;
let truncated = 0;

/** company_id -> Meta conversation ids seen, so the report counts distinct. */
const seen = new Map();

console.log("");
console.log(DRY_RUN ? "  DRY RUN - nothing will be written." : "  Writing.");
console.log("");

for (;;) {
  /*
   * A named function in lib/admin-db.ts, not the admin client.
   *
   * This reads across every tenant, which no request-scoped client can do -
   * and that file's rule is that the capability lives behind a short list of
   * bounded queries rather than an exported client. Adding one there is a diff
   * in a file whose whole purpose is to be reviewed; importing the client here
   * would be the thing the rule exists to stop.
   */
  const page = await listStoredWebhookPayloads({
    ...(cursor ? { after: cursor } : {}),
    take: PAGE,
  });

  if (page.length === 0) break;
  cursor = page[page.length - 1].id;

  for (const event of page) {
    events += 1;

    /*
     * A truncated payload is skipped and counted, never guessed at.
     *
     * MAX_WEBHOOK_PAYLOAD_BYTES clips an enormous delivery, so the JSON is not
     * valid and the statuses in it are unrecoverable. Counting them is the
     * point: the report has to say how much of the history this could not
     * reach, or a total that is short by an unknown amount reads as complete.
     */
    if (event.payloadTruncated) {
      truncated += 1;
      continue;
    }

    let parsed;
    try {
      parsed = parseWebhookPayload(JSON.parse(event.payload));
    } catch {
      unparseable += 1;
      continue;
    }

    for (const status of parsed.statuses) {
      statuses += 1;
      if (!status.conversationId) continue;

      const key = `${event.companyId}:${status.conversationId}`;
      if (!seen.has(key)) {
        seen.set(key, true);
        windows += 1;
      }

      if (DRY_RUN) continue;

      const outcome = await withCompany(event.companyId, (db, scoped) =>
        recordConversationCharge(db, scoped, {
          metaConversationId: status.conversationId,
          category: status.category,
          pricingModel: status.pricingModel,
          billable: status.billable,
          wamid: status.wamid,
          /*
           * Meta's own instant, from the stored payload. Never now(): a
           * backfill run today over six months of history must land every
           * charge on the day it happened, or the entire bill appears in one
           * afternoon and every month before it reads as free.
           */
          occurredAt: status.occurredAt,
        }),
      );

      if (outcome.usageRecorded) charged += 1;
    }
  }

  process.stdout.write(`\r  events ${events}  windows ${windows}  charged ${charged}   `);
}

console.log("");
console.log("");
console.log(`  webhook events read      ${events}`);
console.log(`  status callbacks         ${statuses}`);
console.log(`  distinct windows seen    ${windows}`);
console.log(
  DRY_RUN
    ? `  would charge             (run without --dry-run)`
    : `  usage rows written       ${charged}`,
);

/*
 * The two numbers that say what this could NOT reach. Reported even when zero,
 * because "0 truncated" is a fact and a missing line is an unanswered question.
 */
console.log(`  payloads truncated       ${truncated}`);
console.log(`  payloads unparseable     ${unparseable}`);
console.log("");

if (!DRY_RUN && windows > charged) {
  /*
   * Not a failure. The difference is windows Meta told us about and did not
   * bill - free-tier service conversations - plus any already recorded by the
   * live webhook, plus categories we do not model. Printed so the gap is
   * explained rather than noticed later and mistaken for a bug.
   */
  console.log(
    `  ${windows - charged} window(s) produced no charge: non-billable,\n` +
      `  already recorded, or a category conversationUsageKind does not map.\n` +
      `  whatsapp_conversation_charges holds every one of them either way.\n`,
  );
}

process.exit(0);
