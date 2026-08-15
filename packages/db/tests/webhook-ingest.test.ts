import { beforeEach, describe, expect, it } from "vitest";
import {
  ingestWebhookDelivery,
  recordWebhookDelivery,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * One delivery, turned into a thread.
 *
 * Against a real database rather than a mocked client, because every rule this
 * file asserts is a fact about a constraint: the wamid unique is what makes
 * reprocessing safe, the compound uniques are what make the upserts converge,
 * and the unread count is what goes wrong if the insert and the advance come
 * apart. A mock would agree with whatever the code did.
 */

let alpha: SeededCompany;

const NUMBER_ID = "pn-alpha";
const OCCURRED = new Date("2026-08-15T10:00:00.000Z");

interface Fixture {
  integrationId: string;
  numberId: string;
}

let fixture: Fixture;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");

  fixture = await withCompany(alpha.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: NUMBER_ID,
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
    });
    return { integrationId: integration.id, numberId: number.id };
  });
});

/** Meta's envelope, with whatever messages and statuses a test needs. */
function payload(value: {
  messages?: unknown[];
  statuses?: unknown[];
  contacts?: unknown[];
}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+91", phone_number_id: NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

function textMessage(wamid: string, body: string, from = "wa-customer") {
  return {
    id: wamid,
    from,
    timestamp: String(Math.floor(OCCURRED.getTime() / 1000)),
    type: "text",
    text: { body },
  };
}

/** Record a delivery the way the route does, and return the event id. */
async function deliver(body: string, key = "delivery-1"): Promise<string> {
  const result = await withCompany(alpha.id, (db, companyId) =>
    recordWebhookDelivery(db, companyId, {
      integrationId: fixture.integrationId,
      deliveryKey: key,
      payload: body,
    }),
  );

  return result.eventId;
}

function readEvent(eventId: string) {
  return withCompany(alpha.id, (db) =>
    db.whatsAppWebhookEvent.findFirstOrThrow({ where: { id: eventId } }),
  );
}

function readConversations() {
  return withCompany(alpha.id, (db) =>
    db.conversation.findMany({ orderBy: { createdAt: "asc" } }),
  );
}

function readMessages() {
  return withCompany(alpha.id, (db) =>
    db.message.findMany({ orderBy: { occurredAt: "asc" } }),
  );
}

describe("a delivery carrying one message", () => {
  it("creates the contact, the conversation and the message", async () => {
    const eventId = await deliver(
      payload({
        contacts: [{ wa_id: "wa-customer", profile: { name: "Priya" } }],
        messages: [textMessage("wamid.1", "hello")],
      }),
    );

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.status).toBe("processed");
    expect(summary.inserted).toBe(1);

    const contacts = await withCompany(alpha.id, (db) => db.contact.findMany());
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.waId).toBe("wa-customer");
    expect(contacts[0]?.profileName).toBe("Priya");

    const [conversation] = await readConversations();
    expect(conversation?.lastMessagePreview).toBe("hello");
    expect(conversation?.unreadCount).toBe(1);
    expect(conversation?.lastInboundAt?.toISOString()).toBe(OCCURRED.toISOString());
    /* The window opens from the customer's message, not from now. */
    expect(conversation?.windowExpiresAt?.toISOString()).toBe(
      new Date(OCCURRED.getTime() + 24 * 3_600_000).toISOString(),
    );

    const [message] = await readMessages();
    expect(message?.direction).toBe("INBOUND");
    expect(message?.body).toBe("hello");
    expect(message?.wamid).toBe("wamid.1");
  });

  it("marks the event processed once the message is written", async () => {
    const eventId = await deliver(
      payload({ messages: [textMessage("wamid.1", "hello")] }),
    );

    expect((await readEvent(eventId)).processedAt).toBeNull();

    await ingestWebhookDelivery(alpha.id, eventId);

    expect((await readEvent(eventId)).processedAt).not.toBeNull();
  });
});

describe("reprocessing a delivery", () => {
  it("does not duplicate messages or double the unread count", async () => {
    const eventId = await deliver(
      payload({
        messages: [
          textMessage("wamid.1", "first"),
          textMessage("wamid.2", "second"),
        ],
      }),
    );

    const first = await ingestWebhookDelivery(alpha.id, eventId);
    expect(first.inserted).toBe(2);

    /*
     * Meta redelivers, or the job retries. The event is processed by now, so
     * this is the guard that says nothing is written twice - but the stronger
     * case is the one below, where processing genuinely runs again.
     */
    const second = await ingestWebhookDelivery(alpha.id, eventId);
    expect(second.status).toBe("already_processed");
    expect(await readMessages()).toHaveLength(2);
  });

  it("re-runs the whole delivery when it failed part way, without duplicating", async () => {
    const eventId = await deliver(
      payload({
        messages: [
          textMessage("wamid.1", "first"),
          textMessage("wamid.2", "second"),
        ],
      }),
    );

    await ingestWebhookDelivery(alpha.id, eventId);

    /*
     * The state a crash between message two and markWebhookProcessed leaves
     * behind: the messages are in, the event is not marked. Meta's redelivery
     * then re-runs everything.
     */
    await withCompany(alpha.id, (db) =>
      db.whatsAppWebhookEvent.update({
        where: { id: eventId },
        data: { processedAt: null },
      }),
    );

    const rerun = await ingestWebhookDelivery(alpha.id, eventId);

    /* The whole delivery ran. Nothing was inserted, because the wamid unique
       turned both into no-ops - which is what makes re-running safe at all. */
    expect(rerun.status).toBe("processed");
    expect(rerun.messages).toBe(2);
    expect(rerun.inserted).toBe(0);

    expect(await readMessages()).toHaveLength(2);

    const [conversation] = await readConversations();
    expect(conversation?.unreadCount, "the unread badge climbed on redelivery").toBe(2);
  });
});

describe("messages and statuses in one delivery", () => {
  it("applies a status for a message that arrives in the same payload", async () => {
    const eventId = await deliver(
      payload({
        messages: [textMessage("wamid.1", "hello")],
        statuses: [
          {
            id: "wamid.out",
            status: "delivered",
            timestamp: String(Math.floor(OCCURRED.getTime() / 1000)),
            recipient_id: "wa-customer",
          },
        ],
      }),
    );

    /* An outbound message the status belongs to, already sent. */
    await withCompany(alpha.id, async (db, companyId) => {
      const contact = await db.contact.create({
        data: { companyId, waId: "wa-customer" },
      });
      const conversation = await db.conversation.create({
        data: {
          companyId,
          contactId: contact.id,
          whatsappNumberId: fixture.numberId,
        },
      });
      await db.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: "OUTBOUND",
          type: "text",
          status: "SENT",
          wamid: "wamid.out",
          occurredAt: OCCURRED,
        },
      });
    });

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.advanced).toBe(1);

    const outbound = await withCompany(alpha.id, (db) =>
      db.message.findFirstOrThrow({ where: { wamid: "wamid.out" } }),
    );
    expect(outbound.status).toBe("DELIVERED");
  });

  it("applies a status for a message inserted by the same delivery", async () => {
    /*
     * The ordering test, and the reason messages are processed first. Meta
     * batches a message and a status for it into one delivery - a message read
     * on arrival produces both within a second. With statuses first, the status
     * would find no row, report no_such_message, and never be applied again:
     * nothing redelivers a callback we have already answered 200 to.
     *
     * Inbound messages are stored DELIVERED, so `read` is the status that can
     * still move one.
     */
    const eventId = await deliver(
      payload({
        messages: [textMessage("wamid.1", "hello")],
        statuses: [
          {
            id: "wamid.1",
            status: "read",
            timestamp: String(Math.floor(OCCURRED.getTime() / 1000) + 5),
            recipient_id: "wa-customer",
          },
        ],
      }),
    );

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.inserted).toBe(1);
    expect(
      summary.advanced,
      "the status was applied before its message existed",
    ).toBe(1);
    expect(summary.skipped).not.toContain("status_no_such_message");

    const [message] = await readMessages();
    expect(message?.status).toBe("READ");
  });
});

describe("an inbound media message", () => {
  it("is recorded and its download enqueued, never fetched here", async () => {
    const eventId = await deliver(
      payload({
        messages: [
          {
            id: "wamid.img",
            from: "wa-customer",
            timestamp: String(Math.floor(OCCURRED.getTime() / 1000)),
            type: "image",
            image: { id: "meta-media-77", mime_type: "image/jpeg", caption: "the receipt" },
          },
        ],
      }),
    );

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.inserted).toBe(1);

    /* The request is returned for the caller to enqueue. Nothing was fetched,
       and this function has no way to fetch anything. */
    expect(summary.media).toHaveLength(1);
    expect(summary.media[0]?.metaMediaId).toBe("meta-media-77");

    const [message] = await readMessages();
    expect(summary.media[0]?.messageId).toBe(message?.id);
    expect(message?.type).toBe("image");
    /* No bytes yet, and no media row - the fetch job creates it. */
    expect(message?.mediaId).toBeNull();
    /* The caption is the body, so the thread has something to show meanwhile. */
    expect(message?.body).toBe("the receipt");
  });

  it("re-offers the download if the enqueue was lost", async () => {
    const eventId = await deliver(
      payload({
        messages: [
          {
            id: "wamid.img",
            from: "wa-customer",
            timestamp: String(Math.floor(OCCURRED.getTime() / 1000)),
            type: "image",
            image: { id: "meta-media-77", mime_type: "image/jpeg" },
          },
        ],
      }),
    );

    await ingestWebhookDelivery(alpha.id, eventId);

    /* The event is processed, so nothing re-inserts. The bytes are still
       missing, which is the only evidence a lost enqueue leaves. */
    const again = await ingestWebhookDelivery(alpha.id, eventId);

    expect(again.status).toBe("already_processed");
    expect(again.media).toHaveLength(1);
    expect(again.media[0]?.metaMediaId).toBe("meta-media-77");
  });
});

describe("the contact's profile name", () => {
  it("is not blanked by a later message that omits it", async () => {
    const first = await deliver(
      payload({
        contacts: [{ wa_id: "wa-customer", profile: { name: "Priya" } }],
        messages: [textMessage("wamid.1", "hello")],
      }),
      "delivery-1",
    );
    await ingestWebhookDelivery(alpha.id, first);

    /*
     * Meta sends the profile on the first inbound message of a window and not
     * reliably afterwards. Assigning it unconditionally would replace a stored
     * name with null on the second message of every conversation, and the inbox
     * would show a phone number where it used to show a person.
     */
    const second = await deliver(
      payload({ messages: [textMessage("wamid.2", "still there?")] }),
      "delivery-2",
    );
    await ingestWebhookDelivery(alpha.id, second);

    const contacts = await withCompany(alpha.id, (db) => db.contact.findMany());
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.profileName).toBe("Priya");
  });

  it("is filled in when a later message finally carries one", async () => {
    const first = await deliver(
      payload({ messages: [textMessage("wamid.1", "hello")] }),
      "delivery-1",
    );
    await ingestWebhookDelivery(alpha.id, first);

    const second = await deliver(
      payload({
        contacts: [{ wa_id: "wa-customer", profile: { name: "Priya" } }],
        messages: [textMessage("wamid.2", "hello again")],
      }),
      "delivery-2",
    );
    await ingestWebhookDelivery(alpha.id, second);

    const contacts = await withCompany(alpha.id, (db) => db.contact.findMany());
    expect(contacts[0]?.profileName).toBe("Priya");
  });
});

describe("deliveries that are not processed", () => {
  it("declines a suspended workspace, and says so on the row", async () => {
    const eventId = await deliver(
      payload({ messages: [textMessage("wamid.1", "hello")] }),
    );

    await withCompany(alpha.id, (db) =>
      db.company.update({
        where: { id: alpha.id },
        data: { deactivatedAt: new Date() },
      }),
    );

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    /* Resolution succeeded deliberately (C2); the refusal happens here. */
    expect(summary.status).toBe("skipped");
    expect(summary.skipped).toContain("company_deactivated");
    expect(await readMessages()).toHaveLength(0);

    const event = await readEvent(eventId);
    expect(event.processedAt).not.toBeNull();
    expect(event.skippedReason).toBe("company_deactivated");
  });

  it("records a message for a number this company does not have", async () => {
    const eventId = await deliver(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { phone_number_id: "pn-somebody-else" },
                  messages: [textMessage("wamid.1", "hello")],
                },
              },
            ],
          },
        ],
      }),
    );

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    /* Configuration, not a fault. Failing the job would retry it for ever. */
    expect(summary.skipped).toContain("unknown_phone_number_id");
    expect(summary.inserted).toBe(0);
    expect((await readEvent(eventId)).processedAt).not.toBeNull();
  });

  it("does not fail for ever on a body that was truncated at the cap", async () => {
    const eventId = await deliver("{ this is not json");

    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.skipped).toContain("unparseable_payload");
    /* Marked processed: reprocessing cannot repair a truncated body, and the
       raw payload stays on the row for whoever asks. */
    expect((await readEvent(eventId)).processedAt).not.toBeNull();
  });

  it("does nothing at all for an event in another company", async () => {
    const beta = await seedCompany("beta");
    const eventId = await deliver(
      payload({ messages: [textMessage("wamid.1", "hello")] }),
    );

    const summary = await ingestWebhookDelivery(beta.id, eventId);

    expect(summary.status).toBe("unknown_event");
    expect(await readMessages()).toHaveLength(0);
  });
});
