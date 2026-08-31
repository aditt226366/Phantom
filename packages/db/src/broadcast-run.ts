import type { CompanyClient } from "./with-company.ts";
import { waIdForE164 } from "./broadcasts.ts";

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
 * Find or create the contact and conversation, then write the message.
 *
 * find-or-create rather than create, because a bulk recipient is very often
 * somebody the business already knows - and a second contact row for one
 * person splits their history and their 24-hour window in half.
 *
 * The conversation is per (contact, number), which is the existing unique. A
 * customer messaged by two different numbers of the same business genuinely
 * has two threads; a customer messaged twice by one number has one.
 *
 * windowExpiresAt is untouched. A template does not open a 24-hour window -
 * only the customer writing does - and a broadcast is the coldest possible
 * send. Advancing the window here would make every recipient look reachable by
 * free-form text for a day, which is exactly the mistake sendPolicy exists to
 * prevent.
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
  const waId = waIdForE164(input.phoneE164);

  const contact = await db.contact.upsert({
    where: { companyId_waId: { companyId, waId } },
    create: { companyId, waId, phoneE164: input.phoneE164 },
    /*
     * Empty. Being messaged is not new information about somebody, and
     * rewriting the row would bump updated_at for nothing - and could
     * overwrite a display name a person here typed with a value from a
     * spreadsheet column that is not a name.
     */
    update: {},
    select: { id: true, optedOutAt: true, undeliverableAt: true },
  });

  /*
   * The last filter, at the last moment.
   *
   * The import already dropped these, and hours may have passed since. A
   * contact can opt out between confirming a broadcast and the queue reaching
   * them - and an earlier recipient of this very run can mark this same
   * contact undeliverable. Returning null here means no message row is ever
   * created, which is cleaner than creating one for the send job to refuse.
   */
  if (contact.optedOutAt !== null || contact.undeliverableAt !== null) {
    return null;
  }

  const conversation = await db.conversation.upsert({
    where: {
      companyId_contactId_whatsappNumberId: {
        companyId,
        contactId: contact.id,
        whatsappNumberId: input.whatsappNumberId,
      },
    },
    create: {
      companyId,
      contactId: contact.id,
      whatsappNumberId: input.whatsappNumberId,
    },
    update: {},
    select: { id: true },
  });

  const message = await db.message.create({
    data: {
      companyId,
      conversationId: conversation.id,
      broadcastId: input.broadcastId,
      direction: "OUTBOUND",
      status: "PENDING",
      type: "template",
      /* What the customer will read, so the thread shows the message rather
         than a template name. The payload below is what goes to Meta. */
      body: input.renderedBody,
      templatePayload: {
        name: input.template.name,
        language: input.template.language,
        parameters: input.variables,
      },
      occurredAt: input.occurredAt,
      sentByUserId: input.createdByUserId,
      sendAttempt: 0,
    },
    select: { id: true, sendAttempt: true },
  });

  await db.broadcastRecipient.updateMany({
    where: { id: input.recipientId, companyId, state: "PENDING" },
    data: { state: "SENT", messageId: message.id },
  });

  return {
    recipientId: input.recipientId,
    messageId: message.id,
    sendAttempt: message.sendAttempt,
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
