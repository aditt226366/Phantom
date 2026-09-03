import type { CompanyClient } from "./with-company.ts";
import { claimDriver } from "./conversations.ts";
import { materialiseOutboundTemplate } from "./outbound.ts";
import { Prisma } from "./generated/prisma/client.ts";

/**
 * A bound spreadsheet, and the one write that makes a duplicate impossible.
 *
 * ---------------------------------------------------------------------------
 * The claim is a single transaction, and the order inside it matters
 * ---------------------------------------------------------------------------
 *
 * A poll reads a sheet somebody else is editing, every thirty seconds, for
 * ever. The cursor and the anchor make the common case cheap; neither one is
 * the guarantee. The guarantee is that the row record and the message are
 * written together or not at all, and that the row record carries a unique
 * index the database checks at insert time.
 *
 * The obvious alternative - ask whether we have seen this hash, then send -
 * has a window between the question and the answer. A retrying job beside a
 * poll that is already running will find it, and what comes out of that window
 * is a real customer receiving the same WhatsApp message twice. There is no
 * apology for that and no undo.
 *
 * The key is (company_id, spreadsheet_id, tab, row_hash). The tab is in it
 * because two bindings on different tabs of one workbook is an ordinary setup,
 * and keying per file made the second one permanently dead - see
 * 20260904090000. Two bindings on the same tab still collide, which is the case
 * worth protecting.
 *
 * So: one withCompany scope, which is one transaction. The insert goes FIRST,
 * so the unique refuses a duplicate before any message exists. Then the
 * message. If either fails the whole thing rolls back and the lead is
 * untouched - which is recoverable, because the next poll will see it again.
 */

/** The reason a claim produced nothing, when it produced nothing. */
export type LeadClaimOutcome =
  /** A message row exists and is ready to be enqueued. */
  | { kind: "sent"; rowId: string; messageId: string; sendAttempt: number }
  /** Opted out or undeliverable. Recorded, so it is not reconsidered. */
  | { kind: "skipped"; rowId: string; reason: string }
  /** Another binding on this spreadsheet had already claimed this lead. */
  | { kind: "duplicate" };

export interface LeadClaimInput {
  leadSourceId: string;
  spreadsheetId: string;
  /** Which tab it came from. Part of the unique key since 20260904090000. */
  tab: string;
  rowHash: string;
  whatsappNumberId: string;
  phoneE164: string;
  variables: string[];
  template: { name: string; language: string };
  /** One per quick-reply button, for a binding that starts a flow. */
  buttonPayloads?: readonly string[];
  /**
   * Set only for a VERSE binding: the campaign that will answer the reply.
   *
   * A bare id rather than a relation, matching conversations.driver_ref, which
   * points into two different tables depending on the driver.
   */
  verseCampaignId?: string | null;
  renderedBody: string;
  occurredAt: Date;
  createdByUserId: string | null;
}

/** The sentence a skipped row carries. One wording, so a report cannot vary. */
export const LEAD_SKIP_OPTED_OUT =
  "Opted out, or the number cannot receive WhatsApp";

/**
 * Claim one lead, and turn it into a message if it may be sent.
 *
 * Must be called inside its own `withCompany`, which is what makes it one
 * transaction. Do not wrap two of these in one scope: a duplicate on the
 * second would roll back the first, un-claiming a lead whose message had
 * already been enqueued.
 *
 * A SKIPPED row still occupies a hash, and that is deliberate. A contact who
 * opted out must not be reconsidered on the next poll and the one after it -
 * without the record, every poll for ever re-examines them, and the only thing
 * standing between that and a message is a filter somebody could remove.
 */
export async function claimLeadRow(
  db: CompanyClient,
  companyId: string,
  input: LeadClaimInput,
): Promise<LeadClaimOutcome> {
  /*
   * First, and this order is the whole design. The unique index refuses a
   * second claim of the same lead before anything downstream has happened -
   * no contact touched, no conversation advanced, no message row that would
   * then need un-writing.
   */
  const row = await db.leadSourceRow.create({
    data: {
      companyId,
      leadSourceId: input.leadSourceId,
      spreadsheetId: input.spreadsheetId,
      tab: input.tab,
      rowHash: input.rowHash,
      phoneE164: input.phoneE164,
      /* SKIPPED until a message exists. A crash between here and the update
         leaves a row that says nothing was sent, which is true. */
      state: "SKIPPED",
      skipReason: LEAD_SKIP_OPTED_OUT,
    },
    select: { id: true },
  });

  const outbound = await materialiseOutboundTemplate(db, companyId, {
    whatsappNumberId: input.whatsappNumberId,
    phoneE164: input.phoneE164,
    variables: input.variables,
    template: input.template,
    renderedBody: input.renderedBody,
    occurredAt: input.occurredAt,
    createdByUserId: input.createdByUserId,
    /*
     * Present only for a FLOW binding. A cold lead has no open window, so this
     * is the same approved-template send either way - the payloads are the
     * only difference, and they are what makes a tap start a run.
     */
    ...(input.buttonPayloads && input.buttonPayloads.length > 0
      ? { buttonPayloads: input.buttonPayloads }
      : {}),
  });

  if (!outbound) {
    /* The row already says SKIPPED with this reason. Nothing to write. */
    return { kind: "skipped", rowId: row.id, reason: LEAD_SKIP_OPTED_OUT };
  }

  /*
   * A VERSE binding claims the conversation for the campaign.
   *
   * Without this the template goes out and the customer's reply lands in the
   * inbox unattended - which is a TEMPLATE binding, not a Verse one. The claim
   * is what makes the difference, and it is here rather than in the caller so
   * that it shares the transaction with the message row: a crash between them
   * would otherwise leave a contacted lead nothing is listening to.
   *
   * A refusal is not an error. An automation never displaces another
   * automation, so a lead already mid-conversation with a flow keeps it, and
   * the message still went out - the row is SENT either way. What is lost is
   * only that Verse will not answer this one, which is the correct outcome
   * rather than a failure.
   */
  if (input.verseCampaignId) {
    await claimDriver(db, companyId, outbound.conversationId, {
      driver: "VERSE",
      ref: input.verseCampaignId,
      at: input.occurredAt,
    });
  }

  await db.leadSourceRow.update({
    where: { id: row.id },
    data: { state: "SENT", skipReason: null, messageId: outbound.messageId },
  });

  return {
    kind: "sent",
    rowId: row.id,
    messageId: outbound.messageId,
    sendAttempt: outbound.sendAttempt,
  };
}

/**
 * Whether a thrown error is the unique index refusing a second claim.
 *
 * P2002 carries no constraint name through the driver adapter - the message is
 * literally "Unique constraint failed on the (not available)". That is fine
 * here and would not be elsewhere: `lead_source_rows` has exactly one unique
 * index, so there is no second constraint this could be confused with. If a
 * second one is ever added, this stops being safe and has to become a lookup.
 */
export function isDuplicateLead(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/* ------------------------------------------------------------------------- *
 * Reads and bookkeeping
 * ------------------------------------------------------------------------- */

/**
 * Everything a poll needs, read once.
 *
 * The template and the number come back with the binding, because a poll that
 * re-read them per row would be one query per lead for values that cannot
 * change mid-poll - and the template is RESTRICT-ed against deletion precisely
 * so that stays true.
 */
export async function leadSourceForPoll(
  db: CompanyClient,
  companyId: string,
  leadSourceId: string,
) {
  return db.leadSource.findFirst({
    where: { id: leadSourceId, companyId },
    select: {
      id: true,
      spreadsheetId: true,
      tab: true,
      status: true,
      action: true,
      actionConfig: true,
      whatsappNumberId: true,
      createdByUserId: true,
      cursorCount: true,
      cursorAnchor: true,
      backoffUntil: true,
      template: {
        select: { id: true, name: true, language: true, status: true, components: true },
      },
      /*
       * A FLOW binding sends its flow version's ENTRY template, not the
       * binding's own template column - which is null for one. Selected here
       * so the handler has both without a second round trip, and so which
       * template goes out is decided by the pinned version rather than by
       * whatever is published when the poll happens.
       */
      flowVersionId: true,
      /*
       * The third action's target: a campaign, whose template opens the
       * conversation exactly as the other two kinds' templates do. What
       * differs is only what happens afterwards - the conversation is claimed
       * for Verse, which then answers what comes back.
       */
      verseCampaign: {
        select: {
          id: true,
          status: true,
          template: {
            select: {
              id: true,
              name: true,
              language: true,
              status: true,
              components: true,
            },
          },
        },
      },
      flowVersion: {
        select: {
          id: true,
          graph: true,
          template: {
            select: {
              id: true,
              name: true,
              language: true,
              status: true,
              components: true,
            },
          },
        },
      },
    },
  });
}

export interface PollCounts {
  seen: number;
  sent: number;
  skipped: number;
  rejected: number;
  duplicate: number;
  /** Reject reasons and their counts, to be merged into the stored tally. */
  rejectReasons: Record<string, number>;
}

/**
 * Write down what one poll did.
 *
 * Counters are incremented rather than set, because they describe the binding's
 * whole life and a poll only knows about itself. `rejectReasons` is merged in
 * JavaScript rather than with a jsonb operator: the tally is a handful of keys,
 * and reading-then-writing inside the same transaction that holds the row is
 * exact without needing SQL this repository would then have to justify keeping.
 *
 * lastSentAt moves only when something was actually sent. A binding polling an
 * unchanged sheet every thirty seconds would otherwise report a "last sent"
 * that is always a moment ago, which is the one number on the page a tenant
 * uses to notice that nothing is happening.
 */
export async function recordPoll(
  db: CompanyClient,
  companyId: string,
  leadSourceId: string,
  input: {
    counts: PollCounts;
    cursor: { count: number; anchor: string | null };
    at: Date;
  },
): Promise<void> {
  const existing = await db.leadSource.findFirst({
    where: { id: leadSourceId, companyId },
    select: { rejectReasons: true },
  });

  const tally = mergeReasons(existing?.rejectReasons, input.counts.rejectReasons);

  await db.leadSource.updateMany({
    where: { id: leadSourceId, companyId },
    data: {
      cursorCount: input.cursor.count,
      cursorAnchor: input.cursor.anchor,
      rowsSeen: { increment: input.counts.seen },
      rowsSent: { increment: input.counts.sent },
      rowsSkipped: { increment: input.counts.skipped },
      rowsRejected: { increment: input.counts.rejected },
      rowsDuplicate: { increment: input.counts.duplicate },
      rejectReasons: tally,
      lastPolledAt: input.at,
      ...(input.counts.sent > 0 ? { lastSentAt: input.at } : {}),
      /* A poll that got as far as counting rows read the sheet, so whatever
         was wrong last time is not wrong now. Left alone would leave a
         resolved error on the page for ever. */
      lastError: null,
      lastErrorAt: null,
      backoffUntil: null,
    },
  });

  /*
   * A binding that has just read its sheet is working again.
   *
   * Its own statement, scoped to ERROR, because PAUSED is the tenant's decision
   * and a successful poll must never override it - a stale job finishing after
   * somebody switched a binding off would otherwise switch it back on.
   */
  await db.leadSource.updateMany({
    where: { id: leadSourceId, companyId, status: "ERROR" },
    data: { status: "ACTIVE" },
  });
}

function mergeReasons(
  stored: unknown,
  added: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = {};

  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(added)) {
    merged[key] = (merged[key] ?? 0) + value;
  }

  return merged;
}

/**
 * Write down that a poll could not read the sheet.
 *
 * `demote` is what separates "we cannot see this sheet" from "Google was slow".
 * A lost share is a state the tenant has to act on and the binding says so on
 * its page; a timeout is nothing, and moving a binding to ERROR over one would
 * teach people to ignore the state that matters.
 *
 * The cursor is deliberately untouched. A failed read saw no rows, and
 * advancing past rows nobody looked at is how leads are lost silently.
 */
export async function recordPollFailure(
  db: CompanyClient,
  companyId: string,
  leadSourceId: string,
  input: {
    error: string;
    at: Date;
    demote: boolean;
    /** Set for a quota failure: nothing is polled again before this. */
    backoffUntil?: Date | null;
  },
): Promise<void> {
  await db.leadSource.updateMany({
    /* Never touches a PAUSED binding. The tenant switched it off, and a stale
       job finishing afterwards must not switch it back into an error state. */
    where: { id: leadSourceId, companyId, status: { not: "PAUSED" } },
    data: {
      lastError: input.error,
      lastErrorAt: input.at,
      lastPolledAt: input.at,
      ...(input.backoffUntil ? { backoffUntil: input.backoffUntil } : {}),
      ...(input.demote ? { status: "ERROR" as const } : {}),
    },
  });
}

/** One binding's most recent rows, newest first, for the live feed. */
export async function recentLeadRows(
  db: CompanyClient,
  companyId: string,
  leadSourceId: string,
  take: number,
) {
  return db.leadSourceRow.findMany({
    where: { companyId, leadSourceId },
    /* Tie-broken on id: a poll writes many rows inside one transaction and
       every one carries the same created_at, so ordering on it alone is a
       different sequence run to run - which a screenshot notices even when a
       person would not. */
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      phoneE164: true,
      state: true,
      skipReason: true,
      createdAt: true,
      message: {
        select: { id: true, status: true, errorTitle: true, body: true },
      },
    },
  });
}
