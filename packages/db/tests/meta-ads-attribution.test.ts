import { beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";
import { ingestWebhookDelivery } from "../src/webhook-ingest.ts";
import { recordWebhookDelivery } from "../src/webhook-events.ts";

/**
 * The join between money spent and a person who replied.
 *
 * Meta attaches the referral block to the FIRST inbound message of a
 * conversation an ad started, and to no later message in it. There is no
 * second copy anywhere: their Insights API reports spend per ad and has no idea
 * which WhatsApp thread any of it produced. So everything here is about what
 * happens on that one delivery, and what happens when it arrives twice.
 */

let company: SeededCompany;
let numberId: string;

const PHONE_NUMBER_ID = "109384756201847";

function payload(options: {
  wamid: string;
  from: string;
  referral?: Record<string, string>;
}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [
                { wa_id: options.from, profile: { name: "Anita Desai" } },
              ],
              messages: [
                {
                  id: options.wamid,
                  from: options.from,
                  type: "text",
                  timestamp: "1789000000",
                  text: { body: "Is this still available?" },
                  ...(options.referral ? { referral: options.referral } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

let delivery = 0;

async function deliver(body: unknown): Promise<void> {
  const event = await withCompany(company.id, (db, companyId) =>
    recordWebhookDelivery(db, companyId, {
      integrationId,
      /* One delivery key per CALL, not per payload. Meta redelivering the
         same message is a new delivery of it, and collapsing the two here
         would make the redelivery test assert nothing - the second call would
         never reach the ingest at all. */
      deliveryKey: `test-delivery-${++delivery}`,
      /* The RAW body, as the route received it. The column stores what
         arrived so a backfill can re-parse it years later through the same
         function the live path uses. */
      payload: JSON.stringify(body),
    }),
  );

  await ingestWebhookDelivery(company.id, event.eventId);
}

let integrationId: string;

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("ads");

  const seeded = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
      select: { id: true },
    });

    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: PHONE_NUMBER_ID,
        displayNumber: "+91 98765 43210",
        verifiedName: "Northwind",
      },
      select: { id: true },
    });

    return { integrationId: integration.id, numberId: number.id };
  });

  integrationId = seeded.integrationId;
  numberId = seeded.numberId;
});

const AD_REFERRAL = {
  source_url: "https://fb.me/2abc",
  source_id: "23842000009",
  source_type: "ad",
  headline: "Monsoon sale — 30% off",
  body: "Message us to reserve yours",
  ctwa_clid: "ARBc1234567890",
};

describe("a conversation an ad started", () => {
  it("records the referral, the contact's source and the thread's", async () => {
    await deliver(
      payload({ wamid: "wamid.A1", from: "919000000001", referral: AD_REFERRAL }),
    );

    const state = await withCompany(company.id, async (db, companyId) => ({
      contact: await db.contact.findFirst({
        where: { companyId },
        select: { source: true },
      }),
      conversation: await db.conversation.findFirst({
        where: { companyId },
        select: { source: true },
      }),
      referral: await db.metaAdReferral.findFirst({
        where: { companyId },
        select: {
          ctwaClid: true,
          sourceId: true,
          sourceType: true,
          headline: true,
          occurredAt: true,
        },
      }),
    }));

    expect(state.contact?.source).toBe("ADS_CLICK_TO_WHATSAPP");
    expect(state.conversation?.source).toBe("ADS_CLICK_TO_WHATSAPP");
    expect(state.referral).toMatchObject({
      ctwaClid: "ARBc1234567890",
      sourceId: "23842000009",
      sourceType: "ad",
      headline: "Monsoon sale — 30% off",
    });

    /* Meta's instant, not ours. A backfill re-reading a stored payload months
       later must land on the original moment, or a quarter of attribution
       moves to the day somebody ran the script. */
    expect(state.referral?.occurredAt.toISOString()).toBe(
      new Date(1789000000 * 1000).toISOString(),
    );
  });

  it("writes one referral however many times Meta redelivers", async () => {
    /*
     * Meta redelivers anything it did not get a 200 for, and the redelivery
     * carries the same referral block. Two rows would double every
     * ads-attributed lead count - a number that is merely wrong, on a page
     * where everything else is right.
     */
    const body = payload({
      wamid: "wamid.A2",
      from: "919000000002",
      referral: AD_REFERRAL,
    });

    await deliver(body);
    await deliver(body);

    const count = await withCompany(company.id, (db, companyId) =>
      db.metaAdReferral.count({ where: { companyId } }),
    );

    expect(count).toBe(1);
  });

  it("leaves an ordinary inbound message as INBOUND", async () => {
    await deliver(payload({ wamid: "wamid.B1", from: "919000000003" }));

    const contact = await withCompany(company.id, (db, companyId) =>
      db.contact.findFirst({ where: { companyId }, select: { source: true } }),
    );

    expect(contact?.source).toBe("INBOUND");
  });

  it("ignores a referral block with nothing identifying in it", async () => {
    /*
     * Meta has sent an empty object here. A row for it would put a
     * conversation in the ads-attributed count with no ad to attribute it to -
     * a lead inflating the numerator of every cost-per-lead figure and
     * belonging in none of them.
     */
    await deliver(
      payload({
        wamid: "wamid.B2",
        from: "919000000004",
        referral: { source_type: "ad" },
      }),
    );

    const state = await withCompany(company.id, async (db, companyId) => ({
      referrals: await db.metaAdReferral.count({ where: { companyId } }),
      contact: await db.contact.findFirst({
        where: { companyId },
        select: { source: true },
      }),
    }));

    expect(state.referrals).toBe(0);
    expect(state.contact?.source).toBe("INBOUND");
  });
});

describe("a customer this business already had", () => {
  it("keeps their original source when they later click an ad", async () => {
    /*
     * The expensive half of attribution, and the flattering direction of the
     * error. A contact who wrote in cold in March and clicks an ad in
     * September is a lead the ad did not create; re-stamping them would put
     * the tenant's longest-nurtured contacts into its cost-per-lead
     * denominator and make the ad look better than it was.
     */
    await deliver(payload({ wamid: "wamid.C1", from: "919000000005" }));
    await deliver(
      payload({ wamid: "wamid.C2", from: "919000000005", referral: AD_REFERRAL }),
    );

    const state = await withCompany(company.id, async (db, companyId) => ({
      contact: await db.contact.findFirst({
        where: { companyId },
        select: { source: true },
      }),
      referrals: await db.metaAdReferral.count({ where: { companyId } }),
    }));

    expect(state.contact?.source).toBe("INBOUND");

    /* The referral itself IS recorded. The click happened and the ad should be
       credited with the conversation; what it must not be credited with is
       having found the person. */
    expect(state.referrals).toBe(1);
  });

  it("fills in a source that was never recorded", async () => {
    /*
     * The one case the guarded update exists for: a contact from before this
     * column existed, who arrives through an ad. Null is "nobody asked", so
     * there is nothing to overwrite and the ad genuinely brought this visit.
     */
    await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: { companyId, waId: "919000000006", source: null },
      }),
    );

    await deliver(
      payload({ wamid: "wamid.C3", from: "919000000006", referral: AD_REFERRAL }),
    );

    const contact = await withCompany(company.id, (db, companyId) =>
      db.contact.findFirst({
        where: { companyId, waId: "919000000006" },
        select: { source: true },
      }),
    );

    expect(contact?.source).toBe("ADS_CLICK_TO_WHATSAPP");
  });
});
