import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_PAYLOAD_BYTES,
  countUnprocessedWebhooks,
  markWebhookProcessed,
  recordWebhookDelivery,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Recording a delivery, and the one decision that matters.
 *
 * Everything here is about the conflict path. Dedupe that drops a redelivery
 * unconditionally loses customer messages whenever a job is lost, and that
 * failure is silent - so the recovery case is the test this file exists for.
 */

let alpha: SeededCompany;
let beta: SeededCompany;
let alphaIntegration: string;
let betaIntegration: string;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
  alphaIntegration = await seedIntegration(alpha);
  betaIntegration = await seedIntegration(beta);
});

async function seedIntegration(company: SeededCompany): Promise<string> {
  return withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    return integration.id;
  });
}

async function deliver(
  company: SeededCompany,
  integrationId: string,
  deliveryKey: string,
  payload = '{"entry":[]}',
) {
  return withCompany(company.id, (db, companyId) =>
    recordWebhookDelivery(db, companyId, { integrationId, deliveryKey, payload }),
  );
}

describe("a first delivery", () => {
  it("is recorded and needs a job", async () => {
    const result = await deliver(alpha, alphaIntegration, "key-1");

    expect(result).toMatchObject({
      enqueue: true,
      redelivery: false,
      deliveryCount: 1,
    });
    expect(result.eventId).toBeTruthy();
  });

  it("keeps the body exactly as it arrived", async () => {
    /*
     * Text, not jsonb. The signature was computed over these bytes, so this is
     * the only form that can be re-verified later - jsonb would reorder keys
     * and normalise numbers, and the record would prove nothing about what Meta
     * actually sent.
     */
    const raw = '{"b":1,"a":2,"n":1.50}';
    const { eventId } = await deliver(alpha, alphaIntegration, "key-raw", raw);

    const stored = await withCompany(alpha.id, (db) =>
      db.whatsAppWebhookEvent.findUnique({
        where: { id: eventId },
        select: { payload: true, payloadTruncated: true },
      }),
    );

    expect(stored?.payload).toBe(raw);
    expect(stored?.payloadTruncated).toBe(false);
  });
});

describe("a redelivery", () => {
  it("is enqueued again when the first was never processed", async () => {
    /*
     * The reason this module exists.
     *
     * The first delivery inserted a row and enqueued a job. That job was lost -
     * worker killed mid-restart, Redis flushed, attempts exhausted. Meta's
     * retry is now the only surviving copy of the customer's message, and
     * dropping it because a row exists loses the message for good.
     */
    const first = await deliver(alpha, alphaIntegration, "key-lost");
    expect(first.enqueue).toBe(true);

    const retry = await deliver(alpha, alphaIntegration, "key-lost");

    expect(retry.enqueue).toBe(true);
    expect(retry.redelivery).toBe(true);
    expect(retry.eventId).toBe(first.eventId);
  });

  it("is not enqueued once the work is done", async () => {
    const first = await deliver(alpha, alphaIntegration, "key-done");

    await withCompany(alpha.id, (db, companyId) =>
      markWebhookProcessed(db, companyId, first.eventId),
    );

    const retry = await deliver(alpha, alphaIntegration, "key-done");

    expect(retry.enqueue).toBe(false);
    expect(retry.redelivery).toBe(true);
  });

  it("counts every arrival, so the job id can differ each time", async () => {
    /*
     * BullMQ keeps failed job ids for a day, so a recovery re-enqueued under
     * the id the first attempt used is silently dropped. The count is what
     * makes each attempt's id distinct - the same trap Message.sendAttempt
     * exists for.
     */
    await deliver(alpha, alphaIntegration, "key-count");
    await deliver(alpha, alphaIntegration, "key-count");
    const third = await deliver(alpha, alphaIntegration, "key-count");

    expect(third.deliveryCount).toBe(3);
  });

  it("creates one row per company for the same body", async () => {
    /*
     * Two tenants can legitimately receive byte-identical deliveries - an empty
     * batch, say. One company's traffic must never make another's insert
     * conflict.
     */
    const a = await deliver(alpha, alphaIntegration, "shared-key");
    const b = await deliver(beta, betaIntegration, "shared-key");

    expect(b.eventId).not.toBe(a.eventId);
    expect(b.enqueue).toBe(true);
    expect(b.deliveryCount).toBe(1);
  });
});

describe("an oversized payload", () => {
  it("is truncated and flagged rather than refused", async () => {
    /*
     * One strange delivery must not bloat the table, and must not fail the
     * whole request either - the prefix is still useful for debugging. The flag
     * is a column rather than a marker in the text because the important
     * consequence is that a truncated body can no longer be signature-verified.
     */
    const huge = `{"pad":"${"x".repeat(MAX_WEBHOOK_PAYLOAD_BYTES)}"}`;
    const { eventId } = await deliver(alpha, alphaIntegration, "key-huge", huge);

    const stored = await withCompany(alpha.id, (db) =>
      db.whatsAppWebhookEvent.findUnique({
        where: { id: eventId },
        select: { payload: true, payloadTruncated: true },
      }),
    );

    expect(stored?.payloadTruncated).toBe(true);
    expect(new TextEncoder().encode(stored!.payload).byteLength).toBeLessThanOrEqual(
      MAX_WEBHOOK_PAYLOAD_BYTES,
    );
  });

  it("counts bytes, not characters", async () => {
    /*
     * Meta forwards message text, which is not ASCII. Slicing by string length
     * would let a payload of emoji exceed the byte cap and be refused by the
     * CHECK constraint - the request would fail on a body we could have kept.
     */
    const emoji = `{"t":"${"\u{1F600}".repeat(MAX_WEBHOOK_PAYLOAD_BYTES / 2)}"}`;

    await expect(
      deliver(alpha, alphaIntegration, "key-emoji", emoji),
    ).resolves.toMatchObject({ enqueue: true });
  });
});

describe("the unprocessed backlog", () => {
  it("counts only deliveries that never finished", async () => {
    /*
     * The health check Phase 9's dashboard reads. Without processed_at, an
     * event whose job vanished looks exactly like one handled successfully.
     */
    const lost = await deliver(alpha, alphaIntegration, "key-lost");
    const done = await deliver(alpha, alphaIntegration, "key-done");

    await withCompany(alpha.id, (db, companyId) =>
      markWebhookProcessed(db, companyId, done.eventId),
    );

    const backlog = await withCompany(alpha.id, (db, companyId) =>
      countUnprocessedWebhooks(db, companyId, new Date(Date.now() + 60_000)),
    );

    expect(backlog).toBe(1);
    expect(lost.eventId).toBeTruthy();
  });

  it("counts a deliberate skip as finished", async () => {
    /*
     * A company deactivated mid-conversation is not a stuck job. Marking it
     * processed with a reason is what keeps the backlog honest enough to alert
     * on.
     */
    const skipped = await deliver(alpha, alphaIntegration, "key-skip");

    await withCompany(alpha.id, (db, companyId) =>
      markWebhookProcessed(db, companyId, skipped.eventId, {
        skippedReason: "company_deactivated",
      }),
    );

    const backlog = await withCompany(alpha.id, (db, companyId) =>
      countUnprocessedWebhooks(db, companyId, new Date(Date.now() + 60_000)),
    );

    expect(backlog).toBe(0);
  });
});
