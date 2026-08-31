import { beforeEach, describe, expect, it } from "vitest";
import type { AudienceRow } from "@whatsapp-os/core/bulk";
import {
  resolveAudience,
  uniqueRecipientsSince,
  waIdForE164,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The half of the cleaning pipeline that needs the contact book.
 *
 * Two failures here are completely silent and both reach a real person:
 *
 *   1. An opted-out contact left in the audience. Nothing errors, the message
 *      goes out, and the first anybody knows is a complaint - or a report to
 *      Meta, which costs the number's quality rating.
 *   2. An existing contact treated as new. A second contact row for one
 *      person, with its own conversation and its own history, and neither half
 *      then holds the whole thread.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

function audience(...numbers: string[]): AudienceRow[] {
  return numbers.map((phoneE164) => ({ phoneE164, variables: ["Anita"] }));
}

async function seedContact(
  company: SeededCompany,
  phoneE164: string,
  flags: { optedOut?: boolean; undeliverable?: boolean } = {},
): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    await db.contact.create({
      data: {
        companyId,
        waId: waIdForE164(phoneE164),
        phoneE164,
        ...(flags.optedOut ? { optedOutAt: new Date() } : {}),
        ...(flags.undeliverable ? { undeliverableAt: new Date() } : {}),
      },
    });
  });
}

describe("matching the contact book", () => {
  it("counts a known contact without removing them", () => {
    /*
     * The step of the pipeline where the obvious reading of "dedupe" is the
     * wrong one, so it is asserted rather than left to a comment.
     *
     * A business's existing customers are exactly who a campaign is for.
     * Excluding them would leave bulk messaging able to reach only strangers,
     * which is not a product. What is deduped is the CONTACT ROW - a person
     * already known keeps their row, their conversation and their history.
     */
    return (async () => {
      await seedContact(alpha, "+919876543210");

      const resolved = await withCompany(alpha.id, (db, companyId) =>
        resolveAudience(db, companyId, audience("+919876543210", "+919876543211")),
      );

      expect(resolved.existingCount).toBe(1);
      expect(
        resolved.recipients.map((r) => r.phoneE164),
        "an existing customer was dropped from the campaign",
      ).toEqual(["+919876543210", "+919876543211"]);
    })();
  });

  it("matches on wa_id, which is E.164 without the plus", async () => {
    /* The contact key is Meta's wa_id, not our normalised number. Matching on
       phone_e164 would miss every contact created from an inbound message,
       which is most of them. */
    await seedContact(alpha, "+919876543210");

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, audience("+919876543210")),
    );

    expect(resolved.existingCount).toBe(1);
  });

  it("does not match another company's contacts", async () => {
    await seedContact(beta, "+919876543210", { optedOut: true });

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, audience("+919876543210")),
    );

    /* Not known here, so not excluded here. Beta's opt-out is beta's fact. */
    expect(resolved.existingCount).toBe(0);
    expect(resolved.optedOutCount).toBe(0);
    expect(resolved.recipients).toHaveLength(1);
  });
});

describe("who must not be messaged", () => {
  it("removes a contact who opted out", async () => {
    await seedContact(alpha, "+919876543210", { optedOut: true });

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, audience("+919876543210", "+919876543211")),
    );

    expect(resolved.optedOutCount).toBe(1);
    expect(resolved.recipients.map((r) => r.phoneE164)).toEqual([
      "+919876543211",
    ]);
  });

  it("removes a handset that cannot receive WhatsApp", async () => {
    /* 131026, remembered from a previous broadcast. A fact about the number
       rather than a choice, and skipped for the same practical reason. */
    await seedContact(alpha, "+919876543210", { undeliverable: true });

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, audience("+919876543210")),
    );

    expect(resolved.optedOutCount).toBe(1);
    expect(resolved.recipients).toHaveLength(0);
  });

  it("keeps a known contact who has done neither", async () => {
    await seedContact(alpha, "+919876543210");

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, audience("+919876543210")),
    );

    expect(resolved.optedOutCount).toBe(0);
    expect(resolved.recipients).toHaveLength(1);
  });

  it("preserves file order, so the rejects line up with the upload", async () => {
    await seedContact(alpha, "+919876543211", { optedOut: true });

    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(
        db,
        companyId,
        audience("+919876543210", "+919876543211", "+919876543212"),
      ),
    );

    expect(resolved.recipients.map((r) => r.phoneE164)).toEqual([
      "+919876543210",
      "+919876543212",
    ]);
  });

  it("carries the variables through untouched", async () => {
    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, [
        { phoneE164: "+919876543210", variables: ["Anita", "1204"] },
      ]),
    );

    expect(resolved.recipients[0]?.variables).toEqual(["Anita", "1204"]);
  });

  it("handles an empty audience without a query", async () => {
    const resolved = await withCompany(alpha.id, (db, companyId) =>
      resolveAudience(db, companyId, []),
    );

    expect(resolved).toEqual({
      recipients: [],
      existingCount: 0,
      optedOutCount: 0,
    });
  });
});

describe("the tier's rolling window", () => {
  /* A fixture, outside any `it`. */
  async function seedSent(
    company: SeededCompany,
    input: { contacts: number; messagesEach: number; occurredAt: Date },
  ): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "primary" },
        select: { id: true },
      });
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: "pn-1",
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
        select: { id: true },
      });

      for (let c = 0; c < input.contacts; c++) {
        const contact = await db.contact.create({
          data: { companyId, waId: `9198765430${c}0` },
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

        for (let m = 0; m < input.messagesEach; m++) {
          await db.message.create({
            data: {
              companyId,
              conversationId: conversation.id,
              direction: "OUTBOUND",
              status: "SENT",
              type: "template",
              wamid: `wamid-${c}-${m}`,
              occurredAt: input.occurredAt,
            },
          });
        }
      }

      return number.id;
    });
  }

  it("counts unique recipients, not messages", async () => {
    /*
     * The tier caps unique recipients, so ten messages to one person is one
     * against the allowance. Counting messages would report a number several
     * times too high and refuse broadcasts that fit.
     */
    const numberId = await seedSent(alpha, {
      contacts: 3,
      messagesEach: 4,
      occurredAt: new Date(),
    });

    const used = await withCompany(alpha.id, (db, companyId) =>
      uniqueRecipientsSince(
        db,
        companyId,
        numberId,
        new Date(Date.now() - 24 * 3_600_000),
      ),
    );

    expect(used).toBe(3);
  });

  it("ignores anything outside the window", async () => {
    const numberId = await seedSent(alpha, {
      contacts: 2,
      messagesEach: 1,
      occurredAt: new Date(Date.now() - 48 * 3_600_000),
    });

    const used = await withCompany(alpha.id, (db, companyId) =>
      uniqueRecipientsSince(
        db,
        companyId,
        numberId,
        new Date(Date.now() - 24 * 3_600_000),
      ),
    );

    expect(used).toBe(0);
  });
});
