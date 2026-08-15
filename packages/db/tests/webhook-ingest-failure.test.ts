import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * What a delivery that fails half way leaves behind.
 *
 * This is the property the whole "mark it processed once, at the end" rule
 * exists for, and it is the one thing the main ingest suite cannot show: every
 * assertion there runs a delivery to completion, and a run that completes looks
 * identical whether the event was marked at the start or at the end. The
 * difference only appears when something in the middle throws.
 *
 * So one fault is injected. applyStatusUpdate fails once - a lock timeout, a
 * dropped connection, the ordinary way a database call fails - after the
 * messages in the same delivery have already been written.
 *
 * Mocked here and nowhere else. Everything else about ingestion is asserted
 * against a real database in webhook-ingest.test.ts, because it is all facts
 * about constraints; this file is about control flow, and the only way to
 * observe it is to break something on purpose.
 */

const realConversations = await vi.importActual<
  typeof import("../src/conversations.ts")
>("../src/conversations.ts");

let failNextStatus = false;

vi.mock("../src/conversations.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/conversations.ts")>(
    "../src/conversations.ts",
  );

  return {
    ...actual,
    applyStatusUpdate: async (...args: Parameters<typeof actual.applyStatusUpdate>) => {
      if (failNextStatus) {
        failNextStatus = false;
        throw new Error("simulated: connection reset while applying a status");
      }
      return actual.applyStatusUpdate(...args);
    },
  };
});

const { ingestWebhookDelivery } = await import("../src/webhook-ingest.ts");
const { recordWebhookDelivery } = await import("../src/webhook-events.ts");
const { withCompany } = await import("../src/with-company.ts");

let alpha: SeededCompany;
let integrationId: string;

const NUMBER_ID = "pn-alpha";
const OCCURRED = new Date("2026-08-15T10:00:00.000Z");
const STAMP = String(Math.floor(OCCURRED.getTime() / 1000));

beforeEach(async () => {
  await truncateAll();
  failNextStatus = false;
  alpha = await seedCompany("alpha");

  integrationId = await withCompany(alpha.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: NUMBER_ID,
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
    });
    return integration.id;
  });
});

/** Two messages and a status, so there is something after the failure point. */
function body(): string {
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
              metadata: { phone_number_id: NUMBER_ID },
              messages: [
                {
                  id: "wamid.1",
                  from: "wa-customer",
                  timestamp: STAMP,
                  type: "text",
                  text: { body: "first" },
                },
                {
                  id: "wamid.2",
                  from: "wa-customer",
                  timestamp: STAMP,
                  type: "text",
                  text: { body: "second" },
                },
              ],
              statuses: [
                {
                  id: "wamid.1",
                  status: "read",
                  timestamp: STAMP,
                  recipient_id: "wa-customer",
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function deliver(): Promise<string> {
  const result = await withCompany(alpha.id, (db, companyId) =>
    recordWebhookDelivery(db, companyId, {
      integrationId,
      deliveryKey: "delivery-1",
      payload: body(),
    }),
  );
  return result.eventId;
}

describe("a delivery that fails part way through", () => {
  it("leaves the event unprocessed, so Meta's redelivery runs it again", async () => {
    const eventId = await deliver();
    failNextStatus = true;

    await expect(ingestWebhookDelivery(alpha.id, eventId)).rejects.toThrow(
      /connection reset/,
    );

    const event = await withCompany(alpha.id, (db) =>
      db.whatsAppWebhookEvent.findFirstOrThrow({ where: { id: eventId } }),
    );

    /*
     * The whole point. A processed row discards Meta's retry, and the part of
     * the delivery that never got written would be gone with it - a customer
     * message lost with nothing anywhere to say so.
     */
    expect(event.processedAt, "the event was marked before the work finished").toBeNull();
  });

  it("recovers on the re-run without duplicating what already landed", async () => {
    const eventId = await deliver();
    failNextStatus = true;

    await expect(ingestWebhookDelivery(alpha.id, eventId)).rejects.toThrow();

    const afterFailure = await withCompany(alpha.id, (db) =>
      db.message.findMany({ select: { wamid: true } }),
    );
    /* Both messages were written before the status failed. */
    expect(afterFailure).toHaveLength(2);

    /* Meta redelivers. The event is still unprocessed, so everything re-runs. */
    const rerun = await ingestWebhookDelivery(alpha.id, eventId);

    expect(rerun.status).toBe("processed");
    expect(rerun.messages).toBe(2);
    /*
     * Nothing inserted, because the wamid unique made both a no-op. This is the
     * dependency that makes re-running a whole delivery the right answer rather
     * than a way to duplicate a customer's messages.
     */
    expect(rerun.inserted).toBe(0);
    expect(rerun.advanced, "the status that failed was never applied").toBe(1);

    const messages = await withCompany(alpha.id, (db) => db.message.findMany());
    expect(messages).toHaveLength(2);

    const [conversation] = await withCompany(alpha.id, (db) =>
      db.conversation.findMany(),
    );
    /* Two messages, counted once each, across a failure and a full re-run. */
    expect(conversation?.unreadCount).toBe(2);
  });
});

describe("the mock", () => {
  it("is the real implementation once the injected failure is spent", async () => {
    /*
     * Guards the tests above: a mock that never delegated would make both of
     * them pass while proving nothing about the code that ships.
     */
    expect(realConversations.applyStatusUpdate).toBeTypeOf("function");
    expect(failNextStatus).toBe(false);

    const eventId = await deliver();
    const summary = await ingestWebhookDelivery(alpha.id, eventId);

    expect(summary.status).toBe("processed");
    expect(summary.inserted).toBe(2);
    expect(summary.advanced).toBe(1);
  });
});
