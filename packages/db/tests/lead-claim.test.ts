import { beforeEach, describe, expect, it } from "vitest";
import { rowHash } from "@whatsapp-os/core/leads-server";
import {
  claimLeadRow,
  isDuplicateLead,
  recordPoll,
  recordPollFailure,
  recentLeadRows,
  waIdForE164,
  withCompany,
  type LeadClaimInput,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The one write a lead source is built on, and the counters beside it.
 *
 * Everything here fails silently in production. A duplicate claim that goes
 * through is a real customer receiving the same WhatsApp message twice, with
 * no error anywhere and no way to un-send it. A claim that is refused when it
 * should not be is a lead nobody ever contacts. Neither shows up as anything
 * but a complaint weeks later.
 */

let company: SeededCompany;
let other: SeededCompany;
let fixture: { templateId: string; numberId: string };

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("acme");
  other = await seedCompany("rival");
  fixture = await seedSendables(company);
});

async function seedSendables(
  target: SeededCompany,
): Promise<{ templateId: string; numberId: string }> {
  return withCompany(target.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "wa" },
      select: { id: true },
    });

    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: `${target.slug}-pn`,
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
      select: { id: true },
    });

    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: "welcome",
        language: "en_US",
        category: "MARKETING",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello {{1}}" }],
      },
      select: { id: true },
    });

    return { templateId: template.id, numberId: number.id };
  });
}

async function seedBinding(
  target: SeededCompany,
  sendables: { templateId: string; numberId: string },
  spreadsheetId = "sheet-1",
): Promise<string> {
  return withCompany(target.id, async (db, companyId) => {
    const source = await db.leadSource.create({
      data: {
        companyId,
        name: "Website enquiries",
        spreadsheetId,
        tab: "Leads",
        actionConfig: {
          kind: "TEMPLATE",
          templateId: sendables.templateId,
          mapping: { phone: "Mobile", variables: { "1": "Name" } },
        },
        templateId: sendables.templateId,
        whatsappNumberId: sendables.numberId,
      },
      select: { id: true },
    });

    return source.id;
  });
}

function claimInput(
  leadSourceId: string,
  sendables: { templateId: string; numberId: string },
  overrides: Partial<LeadClaimInput> = {},
): LeadClaimInput {
  const phoneE164 = overrides.phoneE164 ?? "+919876543210";
  const variables = overrides.variables ?? ["Asha"];

  return {
    leadSourceId,
    spreadsheetId: "sheet-1",
    rowHash: rowHash(phoneE164, variables),
    whatsappNumberId: sendables.numberId,
    phoneE164,
    variables,
    template: { name: "welcome", language: "en_US" },
    renderedBody: `Hello ${variables[0]}`,
    occurredAt: new Date("2026-09-01T10:00:00.000Z"),
    createdByUserId: null,
    ...overrides,
  };
}

/** One claim, in its own scope, the way the poll job calls it. */
async function claim(target: SeededCompany, input: LeadClaimInput) {
  return withCompany(target.id, (db, companyId) =>
    claimLeadRow(db, companyId, input),
  );
}

describe("claiming a lead", () => {
  it("writes an ordinary outbound message row", async () => {
    /*
     * The Phase 5 rule, one producer later: after this runs the lead is an
     * ordinary message. Same status ladder, same thread, same send job - and
     * a template send, because a lead is the coldest possible recipient.
     */
    const binding = await seedBinding(company, fixture);
    const outcome = await claim(company, claimInput(binding, fixture));

    expect(outcome.kind).toBe("sent");
    if (outcome.kind !== "sent") return;

    const message = await withCompany(company.id, (db) =>
      db.message.findFirst({
        where: { id: outcome.messageId },
        select: {
          direction: true,
          status: true,
          type: true,
          body: true,
          broadcastId: true,
          templatePayload: true,
        },
      }),
    );

    expect(message).toMatchObject({
      direction: "OUTBOUND",
      status: "PENDING",
      type: "template",
      body: "Hello Asha",
      /* Not a broadcast. The column that marks a bulk send stays null, so a
         bulk report cannot accidentally count a lead. */
      broadcastId: null,
    });
    expect(message?.templatePayload).toEqual({
      name: "welcome",
      language: "en_US",
      parameters: ["Asha"],
    });
  });

  it("advances the conversation, so the thread is not blank in the inbox", async () => {
    /*
     * Phase 5 shipped a producer that skipped this. Typecheck, lint and the
     * whole db suite passed; the inbox showed sixteen threads reading "No
     * preview" sorting ABOVE the customers who had actually written in,
     * because last_message_at was null. Only a screenshot said so.
     *
     * Sharing materialiseOutboundTemplate is what stops the second producer
     * repeating it, and this is the assertion that proves the sharing works.
     */
    const binding = await seedBinding(company, fixture);
    await claim(company, claimInput(binding, fixture));

    const conversation = await withCompany(company.id, (db) =>
      db.conversation.findFirst({
        select: { lastMessageAt: true, lastMessagePreview: true, windowExpiresAt: true },
      }),
    );

    expect(conversation?.lastMessageAt).toEqual(new Date("2026-09-01T10:00:00.000Z"));
    expect(conversation?.lastMessagePreview).toBe("Hello Asha");
    /* A template does not open a 24-hour window - only the customer writing
       does. Advancing it here would make every lead look reachable by
       free-form text for a day. */
    expect(conversation?.windowExpiresAt).toBeNull();
  });

  it("refuses the same lead a second time", async () => {
    /*
     * The whole feature. A poll runs every thirty seconds against a sheet
     * somebody else is editing, so this WILL be attempted - by a rescan after
     * a deletion, by a retried job, by two workers landing together.
     */
    const binding = await seedBinding(company, fixture);
    const input = claimInput(binding, fixture);

    const first = await claim(company, input);
    expect(first.kind).toBe("sent");

    await expect(claim(company, input)).rejects.toSatisfy(isDuplicateLead);
  });

  it("creates no message at all when the claim is refused", async () => {
    /*
     * The reason the row insert goes FIRST inside the transaction. If the
     * message were written before the unique was checked, a duplicate would
     * leave a real outbound message behind for the send job to find.
     */
    const binding = await seedBinding(company, fixture);
    const input = claimInput(binding, fixture);

    await claim(company, input);
    await claim(company, input).catch(() => undefined);

    const messages = await withCompany(company.id, (db) =>
      db.message.count({ where: { direction: "OUTBOUND" } }),
    );

    expect(messages).toBe(1);
  });

  it("refuses a lead a different binding on the same sheet already claimed", async () => {
    /*
     * Per spreadsheet, not per binding, and this is the decision made visible.
     * Two bindings on one sheet would otherwise both message every row, and
     * the customer hears from the business twice for one enquiry.
     */
    const first = await seedBinding(company, fixture, "shared-sheet");
    const second = await seedBinding(company, fixture, "shared-sheet");

    const input = claimInput(first, fixture, { spreadsheetId: "shared-sheet" });

    await claim(company, input);

    await expect(
      claim(company, { ...input, leadSourceId: second }),
    ).rejects.toSatisfy(isDuplicateLead);
  });

  it("lets the same person be claimed from two different spreadsheets", async () => {
    /* Two sheets are two lists. A person who enquired twice, through two
       forms, has enquired twice. */
    const first = await seedBinding(company, fixture, "sheet-a");
    const second = await seedBinding(company, fixture, "sheet-b");

    await claim(company, claimInput(first, fixture, { spreadsheetId: "sheet-a" }));
    const outcome = await claim(
      company,
      claimInput(second, fixture, { spreadsheetId: "sheet-b" }),
    );

    expect(outcome.kind).toBe("sent");
  });

  it("does not let one company's claim suppress another's", async () => {
    /* company_id leads the unique. Without it, two businesses whose sheets
       hold the same customer would silently take turns not sending. */
    const otherFixture = await seedSendables(other);
    const mine = await seedBinding(company, fixture, "same-id");
    const theirs = await seedBinding(other, otherFixture, "same-id");

    await claim(company, claimInput(mine, fixture, { spreadsheetId: "same-id" }));

    const outcome = await claim(
      other,
      claimInput(theirs, otherFixture, { spreadsheetId: "same-id" }),
    );

    expect(outcome.kind).toBe("sent");
  });
});

describe("the opt-out filter, at the moment of writing", () => {
  async function optOut(phoneE164: string, flag: "opted" | "undeliverable") {
    await withCompany(company.id, (db, companyId) =>
      db.contact.create({
        data: {
          companyId,
          waId: waIdForE164(phoneE164),
          phoneE164,
          ...(flag === "opted"
            ? { optedOutAt: new Date() }
            : { undeliverableAt: new Date() }),
        },
      }),
    );
  }

  it("writes no message for a contact who opted out", async () => {
    const binding = await seedBinding(company, fixture);
    await optOut("+919876543210", "opted");

    const outcome = await claim(company, claimInput(binding, fixture));

    expect(outcome.kind).toBe("skipped");

    const messages = await withCompany(company.id, (db) =>
      db.message.count({ where: { direction: "OUTBOUND" } }),
    );
    expect(messages).toBe(0);
  });

  it("writes no message for a handset that cannot receive WhatsApp", async () => {
    /* 131026. A fact about the number, not the customer's decision - which is
       why undeliverable_at is a separate column, and why both land here. */
    const binding = await seedBinding(company, fixture);
    await optOut("+919876543210", "undeliverable");

    expect((await claim(company, claimInput(binding, fixture))).kind).toBe("skipped");
  });

  it("records the skip, so the next poll does not reconsider them", async () => {
    /*
     * Without the row, every poll for ever re-examines an opted-out contact,
     * and the only thing between that and a message is a filter somebody could
     * remove. The record is what makes the refusal permanent.
     */
    const binding = await seedBinding(company, fixture);
    await optOut("+919876543210", "opted");

    await claim(company, claimInput(binding, fixture));

    await expect(
      claim(company, claimInput(binding, fixture)),
    ).rejects.toSatisfy(isDuplicateLead);
  });

  it("gives a skipped row a reason and no message", async () => {
    /* The CHECK constraint's half that a report depends on: a blank cell where
       the reason should be is how somebody fails to find out why a customer
       was never contacted. */
    const binding = await seedBinding(company, fixture);
    await optOut("+919876543210", "opted");
    await claim(company, claimInput(binding, fixture));

    const rows = await withCompany(company.id, (db, companyId) =>
      recentLeadRows(db, companyId, binding, 10),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("SKIPPED");
    expect(rows[0]?.skipReason).toBeTruthy();
    expect(rows[0]?.message).toBeNull();
  });
});

describe("what a poll writes down", () => {
  it("increments counters rather than replacing them", async () => {
    /* They describe the binding's whole life; a poll only knows about itself. */
    const binding = await seedBinding(company, fixture);

    for (const _ of [1, 2]) {
      await withCompany(company.id, (db, companyId) =>
        recordPoll(db, companyId, binding, {
          counts: {
            seen: 5,
            sent: 2,
            skipped: 1,
            rejected: 1,
            duplicate: 1,
            rejectReasons: { unparseable_phone: 1 },
          },
          cursor: { count: 5, anchor: "anchor-1" },
          at: new Date("2026-09-01T10:00:00.000Z"),
        }),
      );
    }

    const row = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({
        where: { id: binding },
        select: {
          rowsSeen: true,
          rowsSent: true,
          rowsRejected: true,
          rejectReasons: true,
          cursorCount: true,
          cursorAnchor: true,
        },
      }),
    );

    expect(row?.rowsSeen).toBe(10);
    expect(row?.rowsSent).toBe(4);
    expect(row?.rejectReasons).toEqual({ unparseable_phone: 2 });
    expect(row?.cursorCount).toBe(5);
    expect(row?.cursorAnchor).toBe("anchor-1");
  });

  it("leaves last sent alone when nothing was sent", async () => {
    /*
     * A binding polling an unchanged sheet every thirty seconds would
     * otherwise report a "last sent" that is always a moment ago - which is
     * the one number on the page a tenant uses to notice nothing is happening.
     */
    const binding = await seedBinding(company, fixture);

    await withCompany(company.id, (db, companyId) =>
      recordPoll(db, companyId, binding, {
        counts: { seen: 0, sent: 0, skipped: 0, rejected: 0, duplicate: 0, rejectReasons: {} },
        cursor: { count: 0, anchor: null },
        at: new Date("2026-09-01T10:00:00.000Z"),
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({ where: { id: binding }, select: { lastSentAt: true, lastPolledAt: true } }),
    );

    expect(row?.lastSentAt).toBeNull();
    expect(row?.lastPolledAt).toEqual(new Date("2026-09-01T10:00:00.000Z"));
  });

  it("moves a binding to ERROR only when the failure is the tenant's to fix", async () => {
    const binding = await seedBinding(company, fixture);

    await withCompany(company.id, (db, companyId) =>
      recordPollFailure(db, companyId, binding, {
        error: "Google was slow",
        at: new Date(),
        demote: false,
      }),
    );

    const afterTransient = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({
        where: { id: binding },
        select: { status: true, lastError: true },
      }),
    );

    /* A timeout is nothing. Demoting on one teaches people to ignore the state
       that matters. */
    expect(afterTransient?.status).toBe("ACTIVE");
    expect(afterTransient?.lastError).toBe("Google was slow");

    await withCompany(company.id, (db, companyId) =>
      recordPollFailure(db, companyId, binding, {
        error: "We cannot see this sheet",
        at: new Date(),
        demote: true,
      }),
    );

    const afterLostAccess = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({ where: { id: binding }, select: { status: true } }),
    );

    expect(afterLostAccess?.status).toBe("ERROR");
  });

  it("does not advance the cursor on a failed read", async () => {
    /* A failed read saw no rows. Advancing past rows nobody looked at is how
       leads are lost with nothing to say so. */
    const binding = await seedBinding(company, fixture);

    await withCompany(company.id, (db, companyId) =>
      recordPoll(db, companyId, binding, {
        counts: { seen: 3, sent: 3, skipped: 0, rejected: 0, duplicate: 0, rejectReasons: {} },
        cursor: { count: 3, anchor: "a" },
        at: new Date(),
      }),
    );

    await withCompany(company.id, (db, companyId) =>
      recordPollFailure(db, companyId, binding, {
        error: "boom",
        at: new Date(),
        demote: true,
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({
        where: { id: binding },
        select: { cursorCount: true, cursorAnchor: true },
      }),
    );

    expect(row?.cursorCount).toBe(3);
    expect(row?.cursorAnchor).toBe("a");
  });

  it("never switches a paused binding into an error state", async () => {
    /* The tenant switched it off. A stale job finishing afterwards must not
       overwrite that decision with a fault. */
    const binding = await seedBinding(company, fixture);

    await withCompany(company.id, (db) =>
      db.leadSource.update({ where: { id: binding }, data: { status: "PAUSED" } }),
    );

    await withCompany(company.id, (db, companyId) =>
      recordPollFailure(db, companyId, binding, {
        error: "boom",
        at: new Date(),
        demote: true,
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({ where: { id: binding }, select: { status: true } }),
    );

    expect(row?.status).toBe("PAUSED");
  });

  it("clears a resolved error when the sheet reads again", async () => {
    /* Left alone, a fixed problem stays on the page for ever and the tenant
       learns the state means nothing. */
    const binding = await seedBinding(company, fixture);

    await withCompany(company.id, (db, companyId) =>
      recordPollFailure(db, companyId, binding, {
        error: "We cannot see this sheet",
        at: new Date(),
        demote: true,
      }),
    );

    await withCompany(company.id, (db, companyId) =>
      recordPoll(db, companyId, binding, {
        counts: { seen: 1, sent: 0, skipped: 0, rejected: 0, duplicate: 0, rejectReasons: {} },
        cursor: { count: 1, anchor: "a" },
        at: new Date(),
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.leadSource.findFirst({
        where: { id: binding },
        select: { status: true, lastError: true, backoffUntil: true },
      }),
    );

    expect(row?.status).toBe("ACTIVE");
    expect(row?.lastError).toBeNull();
    expect(row?.backoffUntil).toBeNull();
  });
});
