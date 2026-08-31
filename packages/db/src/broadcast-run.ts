import type { CompanyClient } from "./with-company.ts";
import { materialiseOutboundTemplate } from "./outbound.ts";

/**
 * Turning one recipient into a message, which is where bulk stops being
 * special.
 *
 * After this runs, a bulk recipient is an ordinary outbound message row: same
 * status ladder, same delivery callbacks, same retry, same thread. The only
 * trace of the campaign is broadcast_id. Everything downstream - the send job,
 * the webhook, the inbox - already knows what to do with it and needed no
 * change at all.
 */

export interface MaterialisedRecipient {
  recipientId: string;
  messageId: string;
  sendAttempt: number;
}

export interface TemplateForSend {
  name: string;
  language: string;
  /** The BODY text with its {{n}} placeholders, for the rendered preview. */
  body: string;
}

/**
 * Make one recipient into a message, and mark the recipient row as claimed.
 *
 * The message itself is materialiseOutboundTemplate's, shared with the lead
 * source producer since Phase 6 - contact upsert, the last opt-out filter,
 * conversation upsert, the message row and the conversation advance are one
 * behaviour and two copies of it would drift. What is left here is the only
 * part that is about bulk: moving this recipient from PENDING to SENT.
 *
 * "SENT" on the recipient means "handed to the queue", not "Meta took it".
 * What Meta said is on the message row.
 */
export async function materialiseRecipient(
  db: CompanyClient,
  companyId: string,
  input: {
    recipientId: string;
    broadcastId: string;
    whatsappNumberId: string;
    phoneE164: string;
    variables: string[];
    template: TemplateForSend;
    renderedBody: string;
    occurredAt: Date;
    createdByUserId: string | null;
  },
): Promise<MaterialisedRecipient | null> {
  const outbound = await materialiseOutboundTemplate(db, companyId, {
    whatsappNumberId: input.whatsappNumberId,
    phoneE164: input.phoneE164,
    variables: input.variables,
    template: { name: input.template.name, language: input.template.language },
    renderedBody: input.renderedBody,
    occurredAt: input.occurredAt,
    createdByUserId: input.createdByUserId,
    broadcastId: input.broadcastId,
  });

  /*
   * Opted out or undeliverable. No message row was created, and the caller
   * marks the recipient SKIPPED with the reason a report will show.
   */
  if (!outbound) return null;

  await db.broadcastRecipient.updateMany({
    where: { id: input.recipientId, companyId, state: "PENDING" },
    data: { state: "SENT", messageId: outbound.messageId },
  });

  return {
    recipientId: input.recipientId,
    messageId: outbound.messageId,
    sendAttempt: outbound.sendAttempt,
  };
}

/** The next batch of recipients still waiting, in a stable order. */
export async function pendingRecipients(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
  take: number,
): Promise<
  Array<{ id: string; phoneE164: string; variables: string[] }>
> {
  const rows = await db.broadcastRecipient.findMany({
    where: { companyId, broadcastId, state: "PENDING" },
    /* By id, which is a cuid and therefore monotonic enough to be stable.
       Without an explicit order a re-run could interleave batches and schedule
       one recipient twice while missing another. */
    orderBy: { id: "asc" },
    take,
    select: { id: true, phoneE164: true, variables: true },
  });

  return rows.map((row) => ({
    id: row.id,
    phoneE164: row.phoneE164,
    variables: Array.isArray(row.variables)
      ? row.variables.filter((v): v is string => typeof v === "string")
      : [],
  }));
}

/**
 * Everything the run needs, read once.
 *
 * The template and the number come back with the broadcast because a send job
 * per recipient re-reading them would be thousands of identical queries for a
 * value that cannot change mid-run - the template is RESTRICT-ed against
 * deletion precisely so this stays true.
 */
export async function broadcastForRun(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
) {
  return db.broadcast.findFirst({
    where: { id: broadcastId, companyId },
    select: {
      id: true,
      status: true,
      gapMs: true,
      whatsappNumberId: true,
      createdByUserId: true,
      recipientCount: true,
      template: {
        select: { id: true, name: true, language: true, status: true, components: true },
      },
    },
  });
}

/**
 * Mark a broadcast finished, but only if nothing is left.
 *
 * Guarded on there being no PENDING recipients rather than on a count the
 * caller carries, because the run is many jobs and the last one to finish is
 * not necessarily the one holding the largest index. Asking the table is the
 * only version that is right when two workers land together.
 */
export async function completeBroadcastIfDone(
  db: CompanyClient,
  companyId: string,
  broadcastId: string,
  now: Date,
): Promise<boolean> {
  const outstanding = await db.broadcastRecipient.count({
    where: { companyId, broadcastId, state: "PENDING" },
  });

  if (outstanding > 0) return false;

  const { count } = await db.broadcast.updateMany({
    /* RUNNING only: a broadcast paused or cancelled on its final recipient
       must not be reported as having completed. */
    where: { id: broadcastId, companyId, status: "RUNNING" },
    data: { status: "COMPLETED", finishedAt: now },
  });

  return count === 1;
}
