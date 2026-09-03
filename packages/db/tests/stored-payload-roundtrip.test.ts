import { beforeEach, describe, expect, it } from "vitest";

import {
  readInteractivePayload,
  readTemplatePayload,
} from "@whatsapp-os/core/whatsapp";
import {
  materialiseFlowMessage,
  materialiseOutboundTemplate,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * What a producer writes, the send worker reads back as the same thing.
 *
 * ---------------------------------------------------------------------------
 * Why this is against a real database and not a fixture object
 * ---------------------------------------------------------------------------
 *
 * `messages.template_payload` and `messages.interactive_payload` are jsonb.
 * Four producers write them - bulk, lead sources, flows and Verse campaigns -
 * and exactly one thing reads them, the send worker. Both halves were correct
 * in isolation for seven phases and NOTHING asserted that they agree.
 *
 * A hand-written fixture cannot close that gap. Handing the reader an object
 * shaped the way the reader expects proves the reader parses its own
 * expectations, which was never in doubt. The failure this guards is a
 * SERIALISATION mismatch - a value that survives the round trip through
 * Postgres as a different shape than it went in as - and only a real write
 * followed by a real read can see one.
 *
 * ---------------------------------------------------------------------------
 * What a mismatch used to cost
 * ---------------------------------------------------------------------------
 *
 * The readers return null defensively, and the worker used to treat null as
 * "this is an ordinary text message". So a template row whose payload would
 * not read back was sent as free-form text: the wrong message, missing its
 * variables, missing the button payloads that make a tap start a flow - and
 * free-form text is exactly what Meta refuses outside a 24-hour window.
 *
 * The fault therefore arrived as `window_closed` on a message whose window was
 * fine, on precisely the sends that are always to cold recipients. The last
 * describe below is about that: the null is still deliberate, and the caller
 * now has to be able to tell it apart from a genuine text message.
 */

let company: SeededCompany;
let fixture: { numberId: string; conversationId: string; contactId: string };

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("payload-roundtrip");

  fixture = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "roundtrip" },
      select: { id: true },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "pn-roundtrip",
        displayNumber: "+91 12345 00000",
        status: "CONNECTED",
      },
      select: { id: true },
    });
    const contact = await db.contact.create({
      data: { companyId, waId: "911234500099", phoneE164: "+911234500099" },
      select: { id: true },
    });
    const conversation = await db.conversation.create({
      data: {
        companyId,
        contactId: contact.id,
        whatsappNumberId: number.id,
      },
      select: { id: true },
    });

    return {
      numberId: number.id,
      conversationId: conversation.id,
      contactId: contact.id,
    };
  });
});

/** Read the row back exactly as the send worker does. */
function storedPayloads(messageId: string) {
  return withCompany(company.id, (db) =>
    db.message.findFirstOrThrow({
      where: { id: messageId },
      select: { type: true, templatePayload: true, interactivePayload: true },
    }),
  );
}

const AT = new Date("2026-09-08T10:00:00.000Z");

describe("a template written by the shared producer", () => {
  it("reads back as the same name, language and parameters", async () => {
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: ["Asha", "NW-2291"],
        template: { name: "order_shipped", language: "en_US" },
        renderedBody: "Hi Asha, order NW-2291 has left our warehouse.",
        occurredAt: AT,
        createdByUserId: null,
      }),
    );

    expect(produced).not.toBeNull();

    const row = await storedPayloads(produced!.messageId);
    const read = readTemplatePayload(row.templatePayload);

    expect(read).toEqual({
      name: "order_shipped",
      language: "en_US",
      parameters: ["Asha", "NW-2291"],
      buttonPayloads: [],
    });
  });

  it("keeps the parameters in order", async () => {
    /*
     * Meta matches {{1}} and {{2}} by POSITION, so an order lost in the round
     * trip puts the order number where the customer's name goes - a message
     * that sends successfully and reads as nonsense.
     */
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: ["first", "second", "third", "fourth"],
        template: { name: "ordered", language: "en_US" },
        renderedBody: "first second third fourth",
        occurredAt: AT,
        createdByUserId: null,
      }),
    );

    const row = await storedPayloads(produced!.messageId);

    expect(readTemplatePayload(row.templatePayload)?.parameters).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("reads back the button payloads that make a tap start a flow", async () => {
    /*
     * The most consequential half. These ids are what a customer's tap sends
     * back, and they are written once and never migratable - so a payload lost
     * between the producer and the send is a flow whose entry template goes out
     * with Meta's default payloads and whose every tap resolves as not_ours.
     */
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: ["Asha"],
        template: { name: "enquiry_open", language: "en_US" },
        renderedBody: "Hi Asha",
        occurredAt: AT,
        createdByUserId: null,
        buttonPayloads: ["f1.e.ver1.start", "f1.e.ver1.other"],
      }),
    );

    const row = await storedPayloads(produced!.messageId);

    expect(readTemplatePayload(row.templatePayload)?.buttonPayloads).toEqual([
      "f1.e.ver1.start",
      "f1.e.ver1.other",
    ]);
  });

  it("reads back with no buttons when the producer wrote none", async () => {
    /*
     * The producer OMITS the key rather than writing an empty array, so that a
     * row written before flows existed and one written since by a producer
     * with no buttons read identically. This asserts the reader agrees.
     */
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: [],
        template: { name: "plain", language: "en_US" },
        renderedBody: "Plain",
        occurredAt: AT,
        createdByUserId: null,
      }),
    );

    const row = await storedPayloads(produced!.messageId);
    const stored = row.templatePayload as Record<string, unknown>;

    expect(stored["buttonPayloads"]).toBeUndefined();
    expect(readTemplatePayload(row.templatePayload)?.buttonPayloads).toEqual([]);
  });

  it("survives characters that a naive round trip mangles", async () => {
    /*
     * Quotes, backslashes, newlines, a unicode name and an emoji. Every one of
     * these is a value somebody's spreadsheet genuinely contains, and each is
     * a place a hand-rolled serialisation would differ from jsonb.
     */
    const awkward = ['He said "hi"', "back\\slash", "line\nbreak", "Ananya 🌸"];

    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: awkward,
        template: { name: "awkward", language: "en_US" },
        renderedBody: "awkward",
        occurredAt: AT,
        createdByUserId: null,
      }),
    );

    const row = await storedPayloads(produced!.messageId);

    expect(readTemplatePayload(row.templatePayload)?.parameters).toEqual(awkward);
  });
});

describe("an interactive step written by the flow producer", () => {
  it("reads back as the same payload, ids intact", async () => {
    const interactive = {
      type: "button",
      body: { text: "What are you after?" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "f1.r.run1.menu.shoes", title: "Shoes" },
          },
          {
            type: "reply",
            reply: { id: "f1.r.run1.menu.bags", title: "Bags" },
          },
        ],
      },
    };

    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseFlowMessage(db, companyId, {
        conversationId: fixture.conversationId,
        contactId: fixture.contactId,
        renderedBody: "What are you after?",
        interactive,
        occurredAt: AT,
      }),
    );

    expect(produced).not.toBeNull();

    const row = await storedPayloads(produced!.messageId);

    /*
     * Deep equality against what went in. The ids inside name a specific run
     * and node, and rebuilding them from the flow version at send time was
     * considered and refused - it would silently repair a payload whose ids no
     * longer match the run, turning a bug into a question a customer receives.
     */
    expect(readInteractivePayload(row.interactivePayload)).toEqual(interactive);
  });

  it("stores no interactive payload for a plain text step", async () => {
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseFlowMessage(db, companyId, {
        conversationId: fixture.conversationId,
        contactId: fixture.contactId,
        renderedBody: "Thanks, someone will be in touch.",
        interactive: null,
        occurredAt: AT,
      }),
    );

    const row = await storedPayloads(produced!.messageId);

    expect(row.type).toBe("text");
    expect(readInteractivePayload(row.interactivePayload)).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * The silent null
 * ------------------------------------------------------------------------- */

describe("an unreadable payload is distinguishable from a text message", () => {
  /**
   * The property the send path depends on, asserted here rather than trusted.
   *
   * `readTemplatePayload` returns null for both "this is a text message" and
   * "this row claims to be a template and its payload is broken", and those
   * two must be told apart by the caller. The discriminator is the row's own
   * `type` column, which is why the send worker selects it.
   *
   * Before this, the worker had only the null and sent both as text. For the
   * second case that is a different message than the producer wrote - and
   * outside a 24-hour window Meta refuses free-form text, so the fault arrived
   * as `window_closed` on a message whose window was fine.
   */
  it("keeps `type` as the discriminator when a template payload is corrupt", async () => {
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseOutboundTemplate(db, companyId, {
        whatsappNumberId: fixture.numberId,
        phoneE164: "+911234500099",
        variables: ["Asha"],
        template: { name: "order_shipped", language: "en_US" },
        renderedBody: "Hi Asha",
        occurredAt: AT,
        createdByUserId: null,
      }),
    );

    /*
     * Corrupted the way an older build or a bad migration would leave it: the
     * key is there, the shape is wrong. Written through raw SQL because the
     * point is what the COLUMN can hold, not what the ORM's types permit.
     */
    await withCompany(company.id, (db, companyId) =>
      db.$executeRaw`
        UPDATE messages
           SET template_payload = '{"nome": "order_shipped"}'::jsonb
         WHERE id = ${produced!.messageId} AND company_id = ${companyId}`,
    );

    const row = await storedPayloads(produced!.messageId);

    /* The reader cannot read it... */
    expect(readTemplatePayload(row.templatePayload)).toBeNull();
    /* ...and the row still says what it was meant to be. */
    expect(row.type).toBe("template");
  });

  it("keeps `type` as the discriminator when an interactive payload is corrupt", async () => {
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseFlowMessage(db, companyId, {
        conversationId: fixture.conversationId,
        contactId: fixture.contactId,
        renderedBody: "What are you after?",
        interactive: {
          type: "button",
          body: { text: "What are you after?" },
          action: { buttons: [] },
        },
        occurredAt: AT,
      }),
    );

    await withCompany(company.id, (db, companyId) =>
      db.$executeRaw`
        UPDATE messages
           SET interactive_payload = '[]'::jsonb
         WHERE id = ${produced!.messageId} AND company_id = ${companyId}`,
    );

    const row = await storedPayloads(produced!.messageId);

    expect(readInteractivePayload(row.interactivePayload)).toBeNull();
    expect(row.type).toBe("interactive");
  });

  it("returns null for a genuine text message, whose type says so", async () => {
    /* The other side of the discriminator: same null, and the row agrees that
       there was never a payload to read. */
    const produced = await withCompany(company.id, (db, companyId) =>
      materialiseFlowMessage(db, companyId, {
        conversationId: fixture.conversationId,
        contactId: fixture.contactId,
        renderedBody: "Thanks, someone will be in touch.",
        interactive: null,
        occurredAt: AT,
      }),
    );

    const row = await storedPayloads(produced!.messageId);

    expect(readTemplatePayload(row.templatePayload)).toBeNull();
    expect(readInteractivePayload(row.interactivePayload)).toBeNull();
    expect(row.type).toBe("text");
  });
});
