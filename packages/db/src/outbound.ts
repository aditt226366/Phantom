import type { CompanyClient } from "./with-company.ts";
import { advanceConversation } from "./conversations.ts";
import { waIdForE164 } from "./broadcasts.ts";

/**
 * Turning a cold recipient into an ordinary outbound message.
 *
 * ---------------------------------------------------------------------------
 * One producer shape, two producers, and never a second send path
 * ---------------------------------------------------------------------------
 *
 * Phase 5 established the rule with bulk: a broadcast is not a parallel way to
 * send, it is a way to CREATE messages that the one send path then handles.
 * After materialisation a bulk recipient is an ordinary message row - same
 * status ladder, same delivery callbacks, same retry, same thread - and the
 * send job, the webhook and the inbox needed no change at all.
 *
 * Phase 6 is the second producer, and the moment that rule either holds or
 * quietly stops being true. A lead source with its own copy of this would be
 * one edit away from diverging: a window advanced here and not there, an
 * opt-out checked in one and forgotten in the other, a conversation left
 * without a preview so the inbox sorts a thousand silent threads above the
 * customers who actually wrote in. That last one is not hypothetical - it
 * shipped in Phase 5, passed every source-level check, and was caught by a
 * screenshot.
 *
 * So the shared part is here and both producers call it. What stays with each
 * producer is only its own bookkeeping: which recipient row to mark, or which
 * lead row to point at the message.
 */

export interface OutboundTemplateInput {
  whatsappNumberId: string;
  phoneE164: string;
  /** The template's parameters, in Meta's positional order. */
  variables: string[];
  template: { name: string; language: string };
  /** What the customer will read, so the thread shows a message not a name. */
  renderedBody: string;
  occurredAt: Date;
  createdByUserId: string | null;
  /** Set when this message is one recipient of a bulk run. */
  broadcastId?: string | null;
}

export interface OutboundTemplate {
  contactId: string;
  conversationId: string;
  messageId: string;
  sendAttempt: number;
}

/**
 * Find or create the contact and conversation, then write the message.
 *
 * find-or-create rather than create, because a cold recipient is very often
 * somebody the business already knows - and a second contact row for one
 * person splits their history and their 24-hour window in half.
 *
 * The conversation is per (contact, number), which is the existing unique. A
 * customer messaged by two different numbers of the same business genuinely
 * has two threads; a customer messaged twice by one number has one.
 *
 * Returns null when the contact must not be messaged at all. That is the last
 * opt-out filter, at the last moment, and it is deliberately a null rather
 * than a message row for the send job to refuse: no row means nothing to
 * explain to anybody looking at the thread.
 */
export async function materialiseOutboundTemplate(
  db: CompanyClient,
  companyId: string,
  input: OutboundTemplateInput,
): Promise<OutboundTemplate | null> {
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
   * Whoever produced this list already dropped these, and hours may have
   * passed since - or, for a lead source, the row may have been read from the
   * sheet seconds ago while the contact opted out yesterday. A contact can also
   * be marked undeliverable by an EARLIER recipient of this same run.
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
      /*
       * CAMPAIGN, not the INBOUND default.
       *
       * Nobody wrote to us - this thread exists because a list or a
       * spreadsheet said to start it, which is what the enum member is for.
       * The default was left in place through Phase 5 and is wrong in a quiet
       * way: `source` is how an operator tells a customer who got in touch
       * from a stranger who was contacted, and every bulk thread claiming to
       * be inbound makes that column useless exactly where it matters.
       *
       * On create only. A contact who wrote in first has an INBOUND thread and
       * being messaged later does not retroactively make it a campaign.
       */
      source: "CAMPAIGN",
    },
    update: {},
    select: { id: true },
  });

  const message = await db.message.create({
    data: {
      companyId,
      conversationId: conversation.id,
      broadcastId: input.broadcastId ?? null,
      direction: "OUTBOUND",
      status: "PENDING",
      type: "template",
      /* What the customer will read. The payload below is what goes to Meta. */
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

  /*
   * The same advance every other send path makes.
   *
   * Without it the thread shows "No preview" in the inbox and sorts by a null
   * last_message_at, which puts every silent produced thread ABOVE the
   * customers who actually wrote in. Phase 5 shipped exactly that; typecheck,
   * lint and the whole db suite passed, and the screenshot is what said so.
   *
   * windowExpiresAt stays null. A template does not open a 24-hour window -
   * only the customer writing does - and advancing it here would make every
   * recipient look reachable by free-form text for a day, which is the mistake
   * sendPolicy exists to prevent. That is the one field this deliberately does
   * not touch, and the reason this calls advanceConversation rather than
   * writing the columns directly.
   */
  await advanceConversation(db, companyId, conversation.id, {
    occurredAt: input.occurredAt,
    preview: input.renderedBody,
    inbound: false,
    windowExpiresAt: null,
    unread: 0,
  });

  return {
    contactId: contact.id,
    conversationId: conversation.id,
    messageId: message.id,
    sendAttempt: message.sendAttempt,
  };
}
