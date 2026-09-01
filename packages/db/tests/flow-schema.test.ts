import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import { prisma } from "../src/client.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The guarantees the flow tables make, and what happens when something tries to
 * break one.
 *
 * Every constraint asserted here has the same property: without it, the system
 * does not error, it just becomes quietly wrong in a way that surfaces as a
 * customer complaint rather than as a failure. Two live runs on one
 * conversation is two questions the customer can only half answer. A paused run
 * with no position asks them everything again. A step log that can be updated
 * is a record of what a business told a customer that the business can edit.
 *
 * Deliberately not an isolation suite: RLS on these tables is proved by raw SQL
 * in rls-isolation.test.ts, where the ORM is banned because the extension's
 * injected filter would make an ORM assertion pass with every policy dropped.
 * A CHECK constraint and a revoked grant are database facts that the extension
 * cannot fake, so the ORM is the honest way to trip them.
 */

let company: SeededCompany;
let fixture: {
  flowId: string;
  versionId: string;
  conversationId: string;
  contactId: string;
  templateId: string;
};

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("flows");

  fixture = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "flows" },
      select: { id: true },
    });

    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "flow-pn",
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
      select: { id: true },
    });

    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: "flow_entry",
        language: "en_US",
        category: "MARKETING",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello" }],
      },
      select: { id: true },
    });

    const contact = await db.contact.create({
      data: { companyId, waId: "flow-wa", phoneE164: "+919876543210" },
      select: { id: true },
    });

    const conversation = await db.conversation.create({
      data: { companyId, contactId: contact.id, whatsappNumberId: number.id },
      select: { id: true },
    });

    const flow = await db.flow.create({
      data: { companyId, name: "Enquiry" },
      select: { id: true },
    });

    const version = await db.flowVersion.create({
      data: {
        companyId,
        flowId: flow.id,
        version: 1,
        entryTemplateId: template.id,
        graph: { entryNodeId: "start", nodes: [] },
      },
      select: { id: true },
    });

    return {
      flowId: flow.id,
      versionId: version.id,
      conversationId: conversation.id,
      contactId: contact.id,
      templateId: template.id,
    };
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A run's columns, with the live ones set consistently. */
function runData(overrides: Record<string, unknown> = {}) {
  return {
    flowId: fixture.flowId,
    flowVersionId: fixture.versionId,
    conversationId: fixture.conversationId,
    activeConversationId: fixture.conversationId,
    contactId: fixture.contactId,
    currentNodeId: "start",
    ...overrides,
  };
}

describe("one live run per conversation", () => {
  it("allows the first", async () => {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    expect(run.id).toBeTruthy();
  });

  it("refuses a second while the first is live", async () => {
    /*
     * The failure this prevents: two runs both send, both wait, and the
     * customer receives two questions and can only answer one. Whichever they
     * answer, the other run sits there for ever holding a position nobody will
     * ever reach.
     */
    await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() } }),
    );

    await expect(
      withCompany(company.id, (db, companyId) =>
        db.flowRun.create({ data: { companyId, ...runData() } }),
      ),
    ).rejects.toThrow();
  });

  it("allows a new run once the first has finished", async () => {
    /*
     * The other half, and the reason for the NULL-distinct trick rather than a
     * plain unique on conversation_id: a customer coming back next month is
     * ordinary, and a conversation may hold any number of finished runs.
     */
    const first = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    await withCompany(company.id, (db) =>
      db.flowRun.update({
        where: { id: first.id },
        data: {
          status: "COMPLETED",
          activeConversationId: null,
          currentNodeId: null,
          endedAt: new Date(),
        },
      }),
    );

    const second = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    expect(second.id).not.toBe(first.id);
  });

  it("refuses a live run that does not claim its conversation", async () => {
    /*
     * The constraint that makes the unique index MEAN anything. Without it a
     * live run carrying NULL here slips a second live run straight past the
     * index - the exact failure the column exists to prevent, now invisible.
     */
    await expect(
      withCompany(company.id, (db, companyId) =>
        db.flowRun.create({
          data: { companyId, ...runData({ activeConversationId: null }) },
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a run claiming a conversation that is not its own", async () => {
    const other = await withCompany(company.id, async (db, companyId) => {
      const contact = await db.contact.create({
        data: { companyId, waId: "other-wa" },
        select: { id: true },
      });
      const number = await db.whatsAppNumber.findFirstOrThrow({ select: { id: true } });
      return db.conversation.create({
        data: { companyId, contactId: contact.id, whatsappNumberId: number.id },
        select: { id: true },
      });
    });

    /* Otherwise a run holds somebody else's slot while advancing this one. */
    await expect(
      withCompany(company.id, (db, companyId) =>
        db.flowRun.create({
          data: { companyId, ...runData({ activeConversationId: other.id }) },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("a paused run keeps its position", () => {
  it("refuses to pause a run without one", async () => {
    /*
     * The second thing the phase cannot retrofit. A window shutting mid-run is
     * the ordinary case, not an error - the flow simply cannot speak until
     * spoken to - and the whole difference between pausing and failing is that
     * the position survives.
     *
     * A PAUSED row with a NULL current_node_id has lost exactly that, and
     * nothing downstream reports it: the resume starts from the top, and the
     * customer answers the same three questions a second time.
     */
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    await expect(
      withCompany(company.id, (db) =>
        db.flowRun.update({
          where: { id: run.id },
          data: { status: "PAUSED", currentNodeId: null, pausedAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it("allows a pause that keeps it", async () => {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({
        data: { companyId, ...runData({ currentNodeId: "ask_size" }) },
        select: { id: true },
      }),
    );

    const paused = await withCompany(company.id, (db) =>
      db.flowRun.update({
        where: { id: run.id },
        data: { status: "PAUSED", pausedAt: new Date() },
        select: { status: true, currentNodeId: true, activeConversationId: true },
      }),
    );

    /* Still live, still claiming the conversation, still standing somewhere. */
    expect(paused).toEqual({
      status: "PAUSED",
      currentNodeId: "ask_size",
      activeConversationId: fixture.conversationId,
    });
  });

  it("refuses an ended run that still claims to be somewhere", async () => {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    await expect(
      withCompany(company.id, (db) =>
        db.flowRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            activeConversationId: null,
            endedAt: new Date(),
            /* currentNodeId left set. */
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses an ended run with no ending instant", async () => {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    await expect(
      withCompany(company.id, (db) =>
        db.flowRun.update({
          where: { id: run.id },
          data: {
            status: "HANDED_OFF",
            activeConversationId: null,
            currentNodeId: null,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("the step log only appends", () => {
  async function seedStep(): Promise<string> {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    const step = await withCompany(company.id, (db, companyId) =>
      db.flowRunStep.create({
        data: {
          companyId,
          flowRunId: run.id,
          seq: 1,
          kind: "STARTED",
          nodeId: "start",
        },
        select: { id: true },
      }),
    );

    return step.id;
  }

  it("accepts an insert", async () => {
    expect(await seedStep()).toBeTruthy();
  });

  it("refuses an update", async () => {
    /*
     * The grant, not a policy. RLS narrows which ROWS a role may touch within
     * the privileges a GRANT already gives it - it cannot subtract UPDATE from
     * a role that holds it - so this is the half that makes append-only a
     * property of the database rather than of whoever writes the next handler.
     */
    const id = await seedStep();

    await expect(
      withCompany(company.id, (db) =>
        db.flowRunStep.update({ where: { id }, data: { choice: "rewritten" } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a delete", async () => {
    const id = await seedStep();

    await expect(
      withCompany(company.id, (db) => db.flowRunStep.delete({ where: { id } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses two steps claiming the same position in one run", async () => {
    const run = await withCompany(company.id, (db, companyId) =>
      db.flowRun.create({ data: { companyId, ...runData() }, select: { id: true } }),
    );

    await withCompany(company.id, (db, companyId) =>
      db.flowRunStep.create({
        data: { companyId, flowRunId: run.id, seq: 1, kind: "STARTED" },
      }),
    );

    /* Two writers must not both believe they were step 1. */
    await expect(
      withCompany(company.id, (db, companyId) =>
        db.flowRunStep.create({
          data: { companyId, flowRunId: run.id, seq: 1, kind: "SENT" },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("a version says who published it", () => {
  it("refuses a published version with nobody named", async () => {
    /*
     * A published_at with no publisher beside it is the shape of "the system
     * turned this on by itself", and who switched an automated conversation on
     * is the first audit question a tenant asks.
     */
    await expect(
      withCompany(company.id, (db) =>
        db.flowVersion.update({
          where: { id: fixture.versionId },
          data: { publishedAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it("accepts one that names a publisher", async () => {
    const published = await withCompany(company.id, (db) =>
      db.flowVersion.update({
        where: { id: fixture.versionId },
        data: { publishedAt: new Date(), publishedByUserId: company.userIds[0]! },
        select: { publishedByUserId: true },
      }),
    );

    expect(published.publishedByUserId).toBe(company.userIds[0]);
  });
});

describe("a lead source binding names the target its action needs", () => {
  it("refuses a FLOW binding with no version", async () => {
    /*
     * Phase 6 wrote the first arm of this constraint and said in as many words
     * that a second action kind gets its own arm, and that the absence of one
     * should be a migration that fails rather than a binding that polls a
     * sheet and does nothing with what it finds. This is that arm.
     */
    await expect(
      withCompany(company.id, async (db, companyId) => {
        const number = await db.whatsAppNumber.findFirstOrThrow({ select: { id: true } });
        return db.leadSource.create({
          data: {
            companyId,
            name: "Broken binding",
            spreadsheetId: "sheet",
            tab: "Leads",
            action: "FLOW",
            actionConfig: {},
            whatsappNumberId: number.id,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it("refuses a TEMPLATE binding that names only a flow version", async () => {
    await expect(
      withCompany(company.id, async (db, companyId) => {
        const number = await db.whatsAppNumber.findFirstOrThrow({ select: { id: true } });
        return db.leadSource.create({
          data: {
            companyId,
            name: "Confused binding",
            spreadsheetId: "sheet",
            tab: "Leads",
            action: "TEMPLATE",
            actionConfig: {},
            flowVersionId: fixture.versionId,
            whatsappNumberId: number.id,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it("accepts a FLOW binding that names one", async () => {
    const binding = await withCompany(company.id, async (db, companyId) => {
      const number = await db.whatsAppNumber.findFirstOrThrow({ select: { id: true } });
      return db.leadSource.create({
        data: {
          companyId,
          name: "Enquiry flow binding",
          spreadsheetId: "sheet",
          tab: "Leads",
          action: "FLOW",
          actionConfig: { mapping: {} },
          flowVersionId: fixture.versionId,
          whatsappNumberId: number.id,
        },
        select: { id: true, action: true, flowVersionId: true },
      });
    });

    expect(binding.action).toBe("FLOW");
    expect(binding.flowVersionId).toBe(fixture.versionId);
  });
});
