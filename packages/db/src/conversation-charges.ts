import { conversationUsageKind, usageDedupeKey } from "@whatsapp-os/core";

import { recordUsage } from "./usage.ts";
import type { CompanyClient } from "./with-company.ts";

/**
 * Meta's per-conversation charge, recorded once per window.
 *
 * ---------------------------------------------------------------------------
 * One function, two callers, and that is the point
 * ---------------------------------------------------------------------------
 *
 * The live webhook calls this, and so does the backfill that reads payloads
 * stored since Phase 4. Two implementations of "what does this status callback
 * mean for the bill" would be one edit away from disagreeing, and the
 * disagreement would show up as a month where the backfilled total and the live
 * total were computed by different rules - with nothing to say which was right.
 *
 * It is the same argument materialiseOutboundTemplate makes about producers of
 * messages, applied to producers of charges.
 *
 * ---------------------------------------------------------------------------
 * Dedupe is per CONVERSATION, never per message
 * ---------------------------------------------------------------------------
 *
 * Meta charges once per 24-hour window and then sends a status callback for
 * every message in it, at every stage - sent, delivered, read. A single window
 * of ten messages is thirty callbacks carrying the same conversation id and the
 * same pricing block. Keyed per message this would bill thirty times.
 *
 * Both halves are idempotent on that id: the charge row by its unique index,
 * and the usage row by the dedupe key the caller builds from the same value. So
 * the backfill can be run twice over the same events, and a re-delivered
 * webhook cannot double-charge.
 */

export interface ConversationChargeInput {
  /** Meta's id for the 24-hour window. The unit they bill. */
  metaConversationId: string;
  /** marketing | utility | authentication | service, verbatim. Null if absent. */
  category: string | null;
  /** CBP, PMP, … verbatim. Null if absent. */
  pricingModel: string | null;
  billable: boolean;
  /** The message whose callback reported it, for tracing. */
  wamid: string | null;
  /** Meta's instant, never now() - a backfill must land on the original. */
  occurredAt: Date;
}

export interface ConversationChargeOutcome {
  /** False when this window had already been recorded. */
  chargeCreated: boolean;
  /** False when nothing was billable, or the category maps to no kind. */
  usageRecorded: boolean;
  /** Why no usage row, when there is none. Null when one was written. */
  skipped: "not_billable" | "unknown_category" | "already_recorded" | null;
}

/**
 * Record one window, and charge for it when Meta says they are charging.
 *
 * Takes a `db` rather than opening its own scope, like recordUsage and
 * auditWithin: the charge belongs in the same transaction as whatever else the
 * delivery wrote, so a rolled-back ingestion leaves no charge behind.
 */
export async function recordConversationCharge(
  db: CompanyClient,
  companyId: string,
  input: ConversationChargeInput,
): Promise<ConversationChargeOutcome> {
  /*
   * Upsert rather than create-if-absent, and the update is narrow on purpose.
   *
   * The first callback for a window sometimes arrives without a pricing block -
   * `sent` can carry none where `delivered` carries one - so the row may be
   * created bare and completed by a later callback. What it must NOT do is
   * un-say something: a later callback with no pricing block must not blank a
   * category we already have, and a window already marked billable must not
   * become non-billable because one notification omitted the field.
   *
   * So each field is written only when the incoming value is the more
   * informative one. `occurredAt` is left at the first sighting, because the
   * charge belongs to when the window opened rather than to the last message
   * in it.
   */
  const existing = await db.whatsAppConversationCharge.findFirst({
    where: { companyId, metaConversationId: input.metaConversationId },
    select: { id: true, billable: true, category: true, pricingModel: true },
  });

  let chargeCreated = false;

  if (!existing) {
    await db.whatsAppConversationCharge.create({
      data: {
        companyId,
        metaConversationId: input.metaConversationId,
        category: input.category,
        pricingModel: input.pricingModel,
        billable: input.billable,
        firstWamid: input.wamid,
        occurredAt: input.occurredAt,
      },
    });
    chargeCreated = true;
  } else {
    const promote = {
      ...(input.category !== null && existing.category === null
        ? { category: input.category }
        : {}),
      ...(input.pricingModel !== null && existing.pricingModel === null
        ? { pricingModel: input.pricingModel }
        : {}),
      ...(input.billable && !existing.billable ? { billable: true } : {}),
    };

    if (Object.keys(promote).length > 0) {
      await db.whatsAppConversationCharge.updateMany({
        where: { id: existing.id, companyId },
        data: promote,
      });
    }
  }

  /*
   * The charge itself.
   *
   * Only when Meta says billable: a free-tier service window is real, is
   * recorded above, and is not a charge. Reading it any other way would invent
   * spend the tenant was never billed for, which is worse than missing some.
   */
  if (!input.billable) {
    return { chargeCreated, usageRecorded: false, skipped: "not_billable" };
  }

  const kind = conversationUsageKind(input.category ?? "");

  /*
   * A category we do not model is NOT recorded under a guessed kind.
   *
   * Meta has added conversation categories before and will again. Folding an
   * unknown one into `service` because it is the cheapest would understate a
   * bill silently; folding it into `marketing` would overstate it. The window
   * is stored either way with its category verbatim, so a new member is a
   * question this table can answer rather than a gap it hides.
   */
  if (!kind) {
    return { chargeCreated, usageRecorded: false, skipped: "unknown_category" };
  }

  const recorded = await recordUsage(db, companyId, {
    kind,
    /*
     * Keyed on Meta's conversation id and the kind - not on our message id,
     * not on the wamid, not on the delivery. The id IS the billing unit, and it
     * is what makes this safe under re-delivery and under a backfill run twice.
     */
    dedupeKey: usageDedupeKey(kind, input.metaConversationId),
    occurredAt: input.occurredAt,
    /*
     * No token counts. Meta bills per conversation, not per token, and there is
     * nothing in the callback to record - which is exactly what a NULL in those
     * columns means and why they are nullable.
     */
  });

  return {
    chargeCreated,
    usageRecorded: recorded.recorded,
    skipped: recorded.recorded ? null : "already_recorded",
  };
}
