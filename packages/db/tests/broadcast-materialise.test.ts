import { beforeEach, describe, expect, it } from "vitest";

import { materialiseRecipient, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Bulk's producer, against a real database.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists, and why it is late
 * ---------------------------------------------------------------------------
 *
 * `materialiseRecipient` is where a broadcast stops being special: after it, a
 * recipient is an ordinary outbound message row and the send job, the webhook
 * and the inbox need no knowledge of bulk at all. That is Phase 5's central
 * claim and the rule two later phases inherited.
 *
 * It had exactly one test, in the worker, with the database mocked. So the
 * claim was asserted about a stub.
 *
 * ---------------------------------------------------------------------------
 * The assertion that matters is the conversation advance
 * ---------------------------------------------------------------------------
 *
 * Phase 5 shipped this function WITHOUT its `advanceConversation` call.
 * Typecheck, lint and the entire database suite passed. What it produced was
 * sixteen bulk threads reading "No preview" and sorting ABOVE the customers who
 * had actually written in, because `last_message_at` was null - which at ten
 * thousand recipients is a buried inbox. Only a screenshot said so.
 *
 * That regression is now guarded for the OTHER two producers -
 * lead-claim.test.ts asserts it for lead sources, flow-schema.test.ts for flow
 * steps - and was not guarded for bulk, which is the producer it happened in.
 * These are the same assertions, for the place that earned them.
 */

let company: SeededCompany;
let fixture: { numberId: string; broadcastId: string; templateId: string };

const AT = new Date("2026-09-08T10:00:00.000Z");

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("bulk-materialise");

  fixture = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "bulk" },
      select: { id: true },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "pn-bulk",
        displayNumber: "+91 12345 00000",
        status: "CONNECTED",
      },
      select: { id: true },
    });
    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: "order_shipped",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} has shipped." }],
      },
      select: { id: true },
    });
    const broadcast = await db.broadcast.create({
      data: {
        companyId,
        name: "September orders",
        templateId: template.id,
        whatsappNumberId: number.id,
        status: "RUNNING",
        /* Pacing has to be a pace: a CHECK refuses zero, which would make a
           broadcast one burst - the behaviour the gap exists to prevent. */
        gapMs: 1_000,
      },
      select: { id: true },
    });

    return {
      numberId: number.id,
      broadcastId: broadcast.id,
      templateId: template.id,
    };
  });
});

async function seedRecipient(phone: string) {
  return withCompany(company.id, async (db, companyId) => {
    const recipient = await db.broadcastRecipient.create({
      data: {
        companyId,
        broadcastId: fixture.broadcastId,
        phoneE164: phone,
        variables: ["Asha", "NW-2291"],
        state: "PENDING",
      },
      select: { id: true },
    });
    return recipient.id;
  });
}

/**
 * The conversation a produced message landed in.
 *
 * MaterialisedRecipient deliberately returns only the recipient, the message
 * and the attempt - the caller's bookkeeping - so the thread is reached the
 * way anything else would reach it, through the message row.
 */
function conversationOf(messageId: string) {
  return withCompany(company.id, (db) =>
    db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { conversationId: true },
    }),
  );
}

function materialise(recipientId: string, phone: string) {
  return withCompany(company.id, (db, companyId) =>
    materialiseRecipient(db, companyId, {
      recipientId,
      broadcastId: fixture.broadcastId,
      whatsappNumberId: fixture.numberId,
      phoneE164: phone,
      variables: ["Asha", "NW-2291"],
      template: {
        name: "order_shipped",
        language: "en_US",
        body: "Hi {{1}}, order {{2}} has shipped.",
      },
      renderedBody: "Hi Asha, order NW-2291 has shipped.",
      occurredAt: AT,
      createdByUserId: null,
    }),
  );
}

describe("a recipient becomes an ordinary message row", () => {
  it("writes a PENDING outbound template carrying the broadcast id", async () => {
    const recipientId = await seedRecipient("+911234500001");
    const produced = await materialise(recipientId, "+911234500001");

    expect(produced).not.toBeNull();

    const message = await withCompany(company.id, (db) =>
      db.message.findFirstOrThrow({
        where: { id: produced!.messageId },
        select: {
          direction: true,
          status: true,
          type: true,
          body: true,
          broadcastId: true,
          sendAttempt: true,
          templatePayload: true,
        },
      }),
    );

    /*
     * Ordinary in every respect. The point of the claim is that nothing
     * downstream can tell this row apart from one the composer wrote, except
     * by the broadcast_id that says which run produced it.
     */
    expect(message.direction).toBe("OUTBOUND");
    expect(message.status).toBe("PENDING");
    expect(message.type).toBe("template");
    expect(message.body).toBe("Hi Asha, order NW-2291 has shipped.");
    expect(message.broadcastId).toBe(fixture.broadcastId);
    expect(message.sendAttempt).toBe(0);
    expect(message.templatePayload).toMatchObject({
      name: "order_shipped",
      language: "en_US",
      parameters: ["Asha", "NW-2291"],
    });
  });

  it("opens the thread as a CAMPAIGN, not as INBOUND", async () => {
    /*
     * Nobody wrote to us. `source` is how an operator tells a customer who got
     * in touch from a stranger who was contacted, and every bulk thread
     * claiming to be inbound makes the column useless exactly where it matters.
     */
    const recipientId = await seedRecipient("+911234500002");
    const produced = await materialise(recipientId, "+911234500002");

    const { conversationId } = await conversationOf(produced!.messageId);

    const conversation = await withCompany(company.id, (db) =>
      db.conversation.findFirstOrThrow({
        where: { id: conversationId },
        select: { source: true },
      }),
    );

    expect(conversation.source).toBe("CAMPAIGN");
  });

  /* --------------------------------------------------------------------- *
   * The regression a screenshot caught
   * --------------------------------------------------------------------- */

  it("advances the conversation, so the thread is not buried in the inbox", async () => {
    /*
     * THE assertion this file exists for, and the same one lead-claim.test.ts
     * and flow-schema.test.ts already make for the other two producers.
     *
     * Without the advance, last_message_at is null and the preview is empty -
     * so the thread renders "No preview" and sorts above every customer who
     * actually wrote in. At ten thousand recipients that is a buried inbox,
     * and it shipped once with the whole suite green.
     */
    const recipientId = await seedRecipient("+911234500003");
    const produced = await materialise(recipientId, "+911234500003");

    const { conversationId } = await conversationOf(produced!.messageId);

    const conversation = await withCompany(company.id, (db) =>
      db.conversation.findFirstOrThrow({
        where: { id: conversationId },
        select: {
          lastMessageAt: true,
          lastMessagePreview: true,
          windowExpiresAt: true,
          unreadCount: true,
        },
      }),
    );

    /* Exact instant, never a tolerance - a tolerant comparison passes on a UTC
       machine and hides an offset fault on every other one. */
    expect(conversation.lastMessageAt).toEqual(AT);
    expect(conversation.lastMessagePreview).toBe(
      "Hi Asha, order NW-2291 has shipped.",
    );

    /*
     * And the window is NOT opened. A template does not open a 24-hour window -
     * only the customer writing does - so advancing it here would make every
     * recipient look reachable by free-form text for a day, which is the
     * mistake sendPolicy exists to prevent.
     */
    expect(conversation.windowExpiresAt).toBeNull();

    /* Nothing is unread: we sent it. An unread count here would put every
       recipient of a ten-thousand-person run into the needs-attention queue. */
    expect(conversation.unreadCount).toBe(0);
  });

  it("reuses the contact and the thread across two broadcasts", async () => {
    /*
     * find-or-create rather than create, because a cold recipient is very often
     * somebody the business already knows - and a second contact row for one
     * person splits their history and their 24-hour window in half.
     *
     * Across two broadcasts rather than twice in one, because a unique index
     * already makes the second impossible: one person appears at most once in
     * a run, which is bulk's own deduplication. The case this actually guards
     * is September's run and October's reaching the same customer.
     */
    const first = await seedRecipient("+911234500004");
    const produced1 = await materialise(first, "+911234500004");

    const october = await withCompany(company.id, async (db, companyId) => {
      const broadcast = await db.broadcast.create({
        data: {
          companyId,
          name: "October orders",
          templateId: fixture.templateId,
          whatsappNumberId: fixture.numberId,
          status: "RUNNING",
          gapMs: 1_000,
        },
        select: { id: true },
      });
      const recipient = await db.broadcastRecipient.create({
        data: {
          companyId,
          broadcastId: broadcast.id,
          phoneE164: "+911234500004",
          variables: ["Asha", "NW-9999"],
          state: "PENDING",
        },
        select: { id: true },
      });
      return { broadcastId: broadcast.id, recipientId: recipient.id };
    });

    const produced2 = await withCompany(company.id, (db, companyId) =>
      materialiseRecipient(db, companyId, {
        recipientId: october.recipientId,
        broadcastId: october.broadcastId,
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500004",
        variables: ["Asha", "NW-9999"],
        template: {
          name: "order_shipped",
          language: "en_US",
          body: "Hi {{1}}, order {{2}} has shipped.",
        },
        renderedBody: "Hi Asha, order NW-9999 has shipped.",
        occurredAt: new Date("2026-10-08T10:00:00.000Z"),
        createdByUserId: null,
      }),
    );

    const first1 = await conversationOf(produced1!.messageId);
    const second1 = await conversationOf(produced2!.messageId);

    expect(second1.conversationId).toBe(first1.conversationId);

    const contacts = await withCompany(company.id, (db) =>
      db.contact.count({ where: { phoneE164: "+911234500004" } }),
    );
    expect(contacts).toBe(1);
  });
});

describe("who must not be messaged", () => {
  it("returns null for an opted-out contact and writes no message", async () => {
    /*
     * The last filter, at the last moment. Whoever produced this list already
     * dropped them and hours may have passed - or an EARLIER recipient of this
     * same run may have marked them undeliverable.
     *
     * Null rather than a message row for the send job to refuse: no row means
     * nothing to explain to anybody looking at the thread.
     */
    await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: {
          companyId,
          waId: "911234500005",
          phoneE164: "+911234500005",
          optedOutAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      }),
    );

    const recipientId = await seedRecipient("+911234500005");
    const produced = await materialise(recipientId, "+911234500005");

    expect(produced).toBeNull();

    const messages = await withCompany(company.id, (db) =>
      db.message.count({ where: { broadcastId: fixture.broadcastId } }),
    );
    expect(messages).toBe(0);
  });

  it("returns null for an undeliverable handset", async () => {
    /*
     * Separate from opted_out deliberately: an opt-out is the customer's
     * decision, 131026 is a fact about a handset. Collapsing them would tell a
     * business its own customers had unsubscribed when somebody had typed a
     * landline into a spreadsheet.
     */
    await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: {
          companyId,
          waId: "911234500006",
          phoneE164: "+911234500006",
          undeliverableAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      }),
    );

    const recipientId = await seedRecipient("+911234500006");

    expect(await materialise(recipientId, "+911234500006")).toBeNull();
  });
});
