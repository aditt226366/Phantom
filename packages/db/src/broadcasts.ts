import type { AudienceRow } from "@whatsapp-os/core/bulk";
import type { CompanyClient } from "./with-company.ts";

/**
 * The half of the cleaning pipeline that needs a company scope, and the reads
 * a broadcast runs on.
 *
 * packages/core does normalise, reject and dedupe-within-file with no I/O.
 * What is left needs the contact book: matching people already known, and
 * dropping the ones who must never be messaged again.
 */

/**
 * Meta's wa_id for a number in E.164.
 *
 * The wa_id is the E.164 without the leading plus, and it is the contact key
 * because it is the only identity a WhatsApp user has - see the note on
 * Contact.waId. Deriving it is a guess for a cold recipient, and a safe one:
 * the send path reconciles it against whatever Meta returns the first time a
 * message goes out, which is reconcileWaId in the send job.
 */
export function waIdForE164(phoneE164: string): string {
  return phoneE164.startsWith("+") ? phoneE164.slice(1) : phoneE164;
}

export interface ResolvedAudience {
  /** Rows that will be messaged, in file order. */
  recipients: AudienceRow[];
  /**
   * How many of them are already in the contact book.
   *
   * Reported, NOT excluded - and this is the one step of the pipeline where
   * the obvious reading of "dedupe" is the wrong one. A business's existing
   * customers are exactly who a campaign is for; removing them would leave
   * bulk messaging able to reach only strangers. What is deduped is the
   * CONTACT ROW: a person already known keeps their row, their conversation
   * and their history rather than getting a second one.
   */
  existingCount: number;
  /** Dropped because they opted out, or their handset cannot receive. */
  optedOutCount: number;
}

/**
 * Match the audience against the contact book and drop who must not be sent.
 *
 * Two lookups' worth of information in one query. Contacts are keyed on wa_id
 * and that unique index is what makes this a seek per batch rather than a scan
 * of a contact book that will be the largest table in the schema.
 *
 * The opt-out filter runs here AND again inside the send job. Not redundancy -
 * a contact can opt out in the hours between confirming a broadcast and the
 * queue reaching them, and the send job's check is the one that is true at the
 * moment the message would go.
 */
export async function resolveAudience(
  db: CompanyClient,
  companyId: string,
  rows: readonly AudienceRow[],
): Promise<ResolvedAudience> {
  if (rows.length === 0) {
    return { recipients: [], existingCount: 0, optedOutCount: 0 };
  }

  const waIds = rows.map((row) => waIdForE164(row.phoneE164));

  const known = await db.contact.findMany({
    where: { companyId, waId: { in: waIds } },
    select: { waId: true, optedOutAt: true, undeliverableAt: true },
  });

  const byWaId = new Map(known.map((contact) => [contact.waId, contact]));

  const recipients: AudienceRow[] = [];
  let existingCount = 0;
  let optedOutCount = 0;

  for (const row of rows) {
    const contact = byWaId.get(waIdForE164(row.phoneE164));

    if (!contact) {
      recipients.push(row);
      continue;
    }

    existingCount += 1;

    /*
     * Both exclusions in one count, deliberately. To a tenant reading the
     * confirm screen the actionable fact is "N people on your list will not be
     * messaged"; which of them chose that and which have a handset that cannot
     * receive is a question for the report, where the columns are separate.
     */
    if (contact.optedOutAt !== null || contact.undeliverableAt !== null) {
      optedOutCount += 1;
      continue;
    }

    recipients.push(row);
  }

  return { recipients, existingCount, optedOutCount };
}

/**
 * How many unique people this number has started a conversation with in the
 * rolling window Meta's tier is measured over.
 *
 * Counting distinct CONTACTS, not messages: the tier caps unique recipients,
 * so ten messages to one person is one against the allowance. Outbound only,
 * and only rows that actually went - a PENDING row is not yet a conversation
 * Meta has counted.
 *
 * An estimate, and honestly so. Meta counts from its own side and includes
 * conversations this system never saw, so this can only ever be a floor. The
 * confirm screen says "about", and the backoff is what catches the rest.
 */
export async function uniqueRecipientsSince(
  db: CompanyClient,
  companyId: string,
  whatsappNumberId: string,
  since: Date,
): Promise<number> {
  const rows = await db.message.findMany({
    where: {
      companyId,
      direction: "OUTBOUND",
      occurredAt: { gte: since },
      /* Anything Meta has taken. PENDING has not been handed over yet and
         FAILED never was, so neither has consumed the allowance. */
      status: { in: ["SENT", "HELD", "DELIVERED", "READ"] },
      conversation: { whatsappNumberId },
    },
    select: { conversation: { select: { contactId: true } } },
    distinct: ["conversationId"],
  });

  const contacts = new Set(rows.map((row) => row.conversation.contactId));

  return contacts.size;
}

/**
 * Write the audience, in batches.
 *
 * 500 at a time, because withCompany holds a pooled connection and times out
 * after five seconds - and an import of ten thousand rows in one statement is
 * both over that and a lock somebody else's request waits behind. Each batch
 * is its own scope, so a large import is many short transactions rather than
 * one long one.
 *
 * skipDuplicates on the (broadcast_id, phone_e164) unique. In-file deduping
 * already happened in core; this makes a retried batch idempotent instead of
 * a constraint violation that abandons a half-written audience.
 */
export const RECIPIENT_BATCH = 500;

export async function insertRecipientBatch(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
  rows: readonly AudienceRow[],
): Promise<number> {
  const { count } = await db.broadcastRecipient.createMany({
    data: rows.map((row) => ({
      companyId,
      broadcastId,
      phoneE164: row.phoneE164,
      variables: row.variables,
    })),
    skipDuplicates: true,
  });

  return count;
}

/* ------------------------------------------------------------------------- *
 * The run
 * ------------------------------------------------------------------------- */

export type RunState = "runnable" | "paused" | "stopped";

/**
 * May this broadcast send right now?
 *
 * Read by EVERY send job as it runs, which is what makes pause immediate and
 * cancel clean without touching the delayed jobs already in Redis. Thousands
 * of jobs may be sitting in the queue with their delays computed; removing
 * them would be a slow, racy sweep of a structure that is being consumed at
 * the same time. Letting each one wake up and decline costs one indexed read.
 *
 * "stopped" covers cancelled and completed and a broadcast that has been
 * deleted out from under the queue. All three mean the same thing to a job
 * that is holding a message it has not sent: do not send it.
 */
export async function broadcastRunState(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
): Promise<RunState> {
  const broadcast = await db.broadcast.findFirst({
    where: { id: broadcastId, companyId },
    select: { status: true },
  });

  if (!broadcast) return "stopped";

  switch (broadcast.status) {
    case "RUNNING":
      return "runnable";
    case "PAUSED":
      return "paused";
    default:
      /* DRAFT is here on purpose. A job for a broadcast that somehow went back
         to draft is a job for a broadcast nobody has confirmed. */
      return "stopped";
  }
}

/** Mark one recipient as skipped, with the reason a report will show. */
export async function skipRecipient(
  db: CompanyClient,
  companyId: string,
  recipientId: string,
  reason: string,
): Promise<void> {
  await db.broadcastRecipient.updateMany({
    where: { id: recipientId, companyId, state: "PENDING" },
    data: { state: "SKIPPED", skipReason: reason },
  });
}

/**
 * Every count a broadcast report shows, in one pass.
 *
 * Grouped in the database rather than counted in JavaScript, because a
 * finished broadcast has as many message rows as it had recipients and pulling
 * ten thousand of them back to count them is a page load nobody waits for.
 */
export interface BroadcastProgress {
  /** Recipients not yet attempted. */
  queued: number;
  /** Skipped before any send, with reasons. */
  skipped: number;
  /** Message rows by status. */
  byStatus: Record<string, number>;
  /** Failures grouped by the sentence a person reads. */
  failures: Array<{ title: string; count: number }>;
}

export async function broadcastProgress(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
): Promise<BroadcastProgress> {
  /* The first two are order-independent - both are turned into a lookup below,
     by Map and by Object.fromEntries. `failures` is NOT: it is rendered as a
     list, and its ordering is applied in JavaScript where the counts tie. */
  const [recipientStates, messageStates, failures] = await Promise.all([
    db.broadcastRecipient.groupBy({
      by: ["state"],
      where: { companyId, broadcastId },
      _count: { _all: true },
    }),
    db.message.groupBy({
      by: ["status"],
      where: { companyId, broadcastId },
      _count: { _all: true },
    }),
    db.message.groupBy({
      by: ["errorTitle"],
      where: { companyId, broadcastId, status: "FAILED" },
      _count: { _all: true },
    }),
  ]);

  const byState = new Map(
    recipientStates.map((row) => [row.state as string, row._count._all]),
  );

  return {
    queued: byState.get("PENDING") ?? 0,
    skipped: byState.get("SKIPPED") ?? 0,
    byStatus: Object.fromEntries(
      messageStates.map((row) => [row.status as string, row._count._all]),
    ),
    failures: failures
      .map((row) => ({
        /* Null means a failure with no recorded sentence, which should not
           happen and is rendered rather than hidden - a blank row in a report
           is how somebody notices. */
        title: row.errorTitle ?? "No reason recorded",
        count: row._count._all,
      }))
      /*
       * Then by title, and this one is a JavaScript tie rather than a SQL one.
       * Array.prototype.sort is stable, so two failure kinds with equal counts
       * keep the order they arrived in - which is the order an unordered
       * groupBy handed back, ie. whatever the aggregate hashed to. The report
       * would list the same two reasons in a different order on a reload.
       */
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
  };
}

/* ------------------------------------------------------------------------- *
 * What Meta's refusals change
 * ------------------------------------------------------------------------- */

/**
 * Remember that a handset cannot receive WhatsApp, so no future broadcast
 * tries it again.
 *
 * On the CONTACT rather than on the recipient row, because it is a fact about
 * the number and not about this campaign. Recorded once, honoured for ever, and
 * resolveAudience drops it at import from then on - which is the difference
 * between learning something and repeating a mistake per campaign.
 *
 * Never overwritten if already set: the first time we were told is the honest
 * timestamp, and refreshing it on every retry would lose when it happened.
 */
export async function markContactUndeliverable(
  db: CompanyClient,
  companyId: string,
  contactId: string,
  at: Date,
): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, companyId, undeliverableAt: null },
    data: { undeliverableAt: at },
  });
}

/**
 * Stop a running broadcast because Meta is rate limiting the number.
 *
 * PAUSED rather than CANCELLED: nothing is wrong with the list, and the run
 * should be resumable once the window moves. Every delayed job still in Redis
 * reads this and declines, so the back-off takes effect on the very next
 * message rather than after the remaining thousands have been attempted
 * against a wall.
 *
 * Guarded on RUNNING, so a broadcast somebody has already paused or cancelled
 * is not moved by a late-arriving refusal.
 */
export async function pauseBroadcastForRateLimit(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
): Promise<boolean> {
  const { count } = await db.broadcast.updateMany({
    where: { id: broadcastId, companyId, status: "RUNNING" },
    data: { status: "PAUSED" },
  });

  return count === 1;
}

/**
 * Schedule no more than the number's remaining 24-hour allowance.
 *
 * The tier is the real ceiling and the pace cannot dodge it, so the run stops
 * at the limit rather than throwing the remainder at Meta to be refused. What
 * is left stays PENDING and resumes tomorrow, which is why this pauses instead
 * of completing.
 */
export async function pauseBroadcastAtTierLimit(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
): Promise<boolean> {
  return pauseBroadcastForRateLimit(db, companyId, broadcastId);
}
