import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encodeEntryButtonId, encodeReplyButtonId } from "@whatsapp-os/core/flows";
import { windowExpiryFor } from "@whatsapp-os/core/whatsapp";
import { advanceFlow, withCompany } from "../src/index.ts";
import { prisma } from "../src/client.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * What a tap does, and - mostly - what it is refused.
 *
 * Every assertion here is about a message a customer could plausibly send
 * today, from a button that has been sitting in their chat history for days.
 * WhatsApp buttons never expire, so the stale tap is not an edge case: it is
 * the ordinary consequence of a customer scrolling up, and a runtime that
 * cannot recognise one advances a conversation nobody is having.
 */

let company: SeededCompany;
let fixture: Awaited<ReturnType<typeof seedFlow>>;

/** A small but real tree: entry, a question, an action, an end and a handoff. */
const GRAPH = {
  entryNodeId: "start",
  nodes: [
    {
      id: "start",
      kind: "entry",
      templateId: "PLACEHOLDER",
      variables: [],
      choices: [{ key: "yes", label: "Yes please", next: "menu" }],
    },
    {
      id: "menu",
      kind: "question",
      body: "What are you after?",
      variable: "want",
      presentation: {
        as: "buttons",
        choices: [
          { key: "shoes", label: "Shoes", next: "hot" },
          { key: "help", label: "Talk to someone", next: "human" },
        ],
      },
    },
    {
      id: "hot",
      kind: "action",
      actions: [
        { kind: "set_score", score: "HOT" },
        { kind: "add_tag", tag: "shoes" },
      ],
      next: "bye",
    },
    { id: "bye", kind: "end", body: "Thanks!" },
    { id: "human", kind: "handoff", body: "Someone will be in touch.", note: null },
  ],
};

async function seedFlow(companyId: string) {
  return withCompany(companyId, async (db, scoped) => {
    const integration = await db.integration.create({
      data: { companyId: scoped, provider: "WHATSAPP_CLOUD", label: "flows" },
      select: { id: true },
    });

    const number = await db.whatsAppNumber.create({
      data: {
        companyId: scoped,
        integrationId: integration.id,
        phoneNumberId: "flow-pn",
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
      select: { id: true },
    });

    const template = await db.whatsAppTemplate.create({
      data: {
        companyId: scoped,
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
      data: { companyId: scoped, waId: "flow-wa", phoneE164: "+919876543210" },
      select: { id: true },
    });

    const conversation = await db.conversation.create({
      data: {
        companyId: scoped,
        contactId: contact.id,
        whatsappNumberId: number.id,
        /* The customer has just written, so free-form is legal. */
        windowExpiresAt: windowExpiryFor(new Date()),
      },
      select: { id: true },
    });

    const flow = await db.flow.create({
      data: { companyId: scoped, name: "Enquiry" },
      select: { id: true },
    });

    const graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "start" ? { ...n, templateId: template.id } : n,
      ),
    };

    const publisher = await db.user.findFirstOrThrow({ select: { id: true } });

    const version = await db.flowVersion.create({
      data: {
        companyId: scoped,
        flowId: flow.id,
        version: 1,
        entryTemplateId: template.id,
        graph,
        publishedAt: new Date(),
        /* The CHECK requires a publisher beside published_at: a version that
           went live with nobody named is the shape of "the system turned this
           on by itself". */
        publishedByUserId: publisher.id,
      },
      select: { id: true },
    });

    await db.flow.update({
      where: { id: flow.id },
      data: { publishedVersionId: version.id },
    });

    return {
      flowId: flow.id,
      versionId: version.id,
      conversationId: conversation.id,
      contactId: contact.id,
      templateId: template.id,
      numberId: number.id,
    };
  });
}

/** An inbound message row, as the webhook ingest would have written it. */
async function inbound(text: string | null): Promise<string> {
  const message = await withCompany(company.id, (db, scoped) =>
    db.message.create({
      data: {
        companyId: scoped,
        conversationId: fixture.conversationId,
        direction: "INBOUND",
        status: "DELIVERED",
        type: "interactive",
        wamid: `wamid.${Math.random().toString(36).slice(2)}`,
        body: text,
        occurredAt: new Date(),
      },
      select: { id: true },
    }),
  );

  return message.id;
}

async function tap(replyId: string | null, text: string | null = null) {
  const messageId = await inbound(text);

  return advanceFlow(company.id, {
    conversationId: fixture.conversationId,
    messageId,
    replyId,
    text,
    occurredAt: new Date(),
  });
}

function steps() {
  return withCompany(company.id, (db) =>
    db.flowRunStep.findMany({
      orderBy: { seq: "asc" },
      select: { kind: true, nodeId: true, choice: true, detail: true },
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("flows");
  fixture = await seedFlow(company.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("starting a run", () => {
  it("creates one on a tap of the entry template, and sends the first question", async () => {
    const result = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    expect(result.sends).toHaveLength(1);

    const run = await withCompany(company.id, (db) =>
      db.flowRun.findFirstOrThrow({
        select: { status: true, currentNodeId: true, flowVersionId: true },
      }),
    );

    expect(run.status).toBe("ACTIVE");
    expect(run.currentNodeId).toBe("menu");
    /* The pin, written at creation and never updated. */
    expect(run.flowVersionId).toBe(fixture.versionId);
  });

  it("puts the run and the node in every button it sends", async () => {
    const result = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    if (result.outcome !== "started") throw new Error("expected a run to start");

    const message = await withCompany(company.id, (db) =>
      db.message.findFirstOrThrow({
        where: { id: result.sends[0]!.messageId },
        select: { type: true, interactivePayload: true },
      }),
    );

    expect(message.type).toBe("interactive");

    const payload = message.interactivePayload as {
      action: { buttons: Array<{ reply: { id: string } }> };
    };

    expect(payload.action.buttons.map((b) => b.reply.id)).toEqual([
      `f1.r.${result.runId}.menu.shoes`,
      `f1.r.${result.runId}.menu.help`,
    ]);
  });

  it("does not create a run for a version that is no longer published", async () => {
    /*
     * The template was sent last month; the tenant has published twice since.
     * A tap today must not open a conversation the tenant stopped having.
     */
    await withCompany(company.id, (db) =>
      db.flow.update({
        where: { id: fixture.flowId },
        data: { publishedVersionId: null },
      }),
    );

    const result = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    expect(result).toEqual({
      outcome: "declined",
      reason: "version_unpublished",
      runId: null,
    });

    const runs = await withCompany(company.id, (db) => db.flowRun.count());
    expect(runs).toBe(0);
  });

  it("declines a second entry tap while a run is already live", async () => {
    await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    const again = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    expect(again.outcome).toBe("declined");
    if (again.outcome !== "declined") return;
    expect(again.reason).toBe("run_already_active");
  });
});

describe("the stale-press guard", () => {
  async function startAndAdvance() {
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");
    return started.runId;
  }

  it("declines a tap naming a node the run has already left", async () => {
    /*
     * The one the whole encoding exists for. The run moved on; the button is
     * still in the chat. Without the node in the id this tap is
     * indistinguishable from a live answer, and obeying it would advance a
     * conversation on the strength of a press from days ago.
     */
    const runId = await startAndAdvance();

    /* Answer the question, which moves the run off "menu" and ends it. */
    await tap(encodeReplyButtonId({ runId, nodeId: "menu", choice: "shoes" }));

    /* Now scroll up and press the old button again. */
    const stale = await tap(
      encodeReplyButtonId({ runId, nodeId: "menu", choice: "help" }),
    );

    expect(stale.outcome).toBe("declined");
    if (stale.outcome !== "declined") return;
    /* run_ended, because that first answer completed it. */
    expect(stale.reason).toBe("run_ended");
  });

  it("declines a tap for a node the run left while still live", async () => {
    const runId = await startAndAdvance();

    /* Move the run somewhere else without ending it. */
    await withCompany(company.id, (db) =>
      db.flowRun.update({ where: { id: runId }, data: { currentNodeId: "human" } }),
    );

    const stale = await tap(
      encodeReplyButtonId({ runId, nodeId: "menu", choice: "shoes" }),
    );

    expect(stale.outcome).toBe("declined");
    if (stale.outcome !== "declined") return;
    expect(stale.reason).toBe("stale_node");
  });

  it("records every decline, so 'the bot ignored me' is answerable", async () => {
    const runId = await startAndAdvance();
    await tap(encodeReplyButtonId({ runId, nodeId: "menu", choice: "shoes" }));
    await tap(encodeReplyButtonId({ runId, nodeId: "menu", choice: "help" }));

    const log = await steps();
    const declined = log.filter((s) => s.kind === "DECLINED");

    expect(declined).toHaveLength(1);
    expect(declined[0]!.nodeId).toBe("menu");
    expect(declined[0]!.detail).toMatchObject({ reason: "run_ended" });
  });

  it("sends nothing when it declines", async () => {
    /*
     * The failure a decline exists to prevent is not a log line, it is a
     * message. A customer who scrolled up and pressed an old button must not
     * receive the next question of a finished conversation.
     */
    const runId = await startAndAdvance();
    await tap(encodeReplyButtonId({ runId, nodeId: "menu", choice: "shoes" }));

    const before = await withCompany(company.id, (db) =>
      db.message.count({ where: { direction: "OUTBOUND" } }),
    );

    await tap(encodeReplyButtonId({ runId, nodeId: "menu", choice: "help" }));

    const after = await withCompany(company.id, (db) =>
      db.message.count({ where: { direction: "OUTBOUND" } }),
    );

    expect(after).toBe(before);
  });

  it("ignores a button from another system entirely", async () => {
    /*
     * A customer with two vendors in their WhatsApp. Not our error, and
     * recording it as one would make a flow's decline count a count of other
     * people's buttons.
     */
    expect(await tap("ORDER_CONFIRM_YES")).toEqual({ outcome: "no_flow" });
  });

  it("declines a run id that belongs to nobody", async () => {
    const result = await tap(
      encodeReplyButtonId({ runId: "notarealrun", nodeId: "menu", choice: "shoes" }),
    );

    expect(result).toEqual({
      outcome: "declined",
      reason: "unknown_run",
      runId: null,
    });
  });
});

describe("version pinning", () => {
  it("keeps a run on the tree it started on after the flow is republished", async () => {
    /*
     * The customer is standing on "menu". The tenant publishes a version that
     * has no such node. If the run read the flow's CURRENT graph, the next tap
     * would name a node that does not exist and the only honest thing to do
     * with it would be nothing.
     */
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await withCompany(company.id, async (db, scoped) => {
      const replacement = await db.flowVersion.create({
        data: {
          companyId: scoped,
          flowId: fixture.flowId,
          version: 2,
          entryTemplateId: fixture.templateId,
          graph: {
            entryNodeId: "start",
            nodes: [
              {
                id: "start",
                kind: "entry",
                templateId: fixture.templateId,
                variables: [],
                choices: [{ key: "yes", label: "Yes", next: "finish" }],
              },
              { id: "finish", kind: "end", body: "All done." },
            ],
          },
          publishedAt: new Date(),
          publishedByUserId: (
            await db.user.findFirstOrThrow({ select: { id: true } })
          ).id,
        },
        select: { id: true },
      });

      await db.flow.update({
        where: { id: fixture.flowId },
        data: { publishedVersionId: replacement.id },
      });
    });

    /* The customer answers the question version 1 asked them. */
    const answered = await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "shoes" }),
    );

    expect(answered.outcome).toBe("ended");

    /* And version 1's action node ran, which version 2 does not contain. */
    const contact = await withCompany(company.id, (db) =>
      db.contact.findFirstOrThrow({
        where: { id: fixture.contactId },
        select: { leadScore: true, tags: true },
      }),
    );

    expect(contact.leadScore).toBe("HOT");
    expect(contact.tags).toEqual(["shoes"]);
  });
});

describe("action nodes", () => {
  it("scores the lead, tags the contact and records what it did", async () => {
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "shoes" }),
    );

    const contact = await withCompany(company.id, (db) =>
      db.contact.findFirstOrThrow({
        where: { id: fixture.contactId },
        select: { leadScore: true, leadScoreRunId: true, tags: true },
      }),
    );

    expect(contact.leadScore).toBe("HOT");
    expect(contact.leadScoreRunId).toBe(started.runId);
    expect(contact.tags).toEqual(["shoes"]);

    const log = await steps();
    const action = log.find((s) => s.kind === "ACTION");
    expect(action?.detail).toMatchObject({
      actions: [
        { kind: "set_score", score: "HOT" },
        { kind: "add_tag", tag: "shoes", added: true },
      ],
    });
  });

  it("does not add the same tag twice when a customer loops", async () => {
    /*
     * A menu loop is an ordinary thing to draw, and a contact card reading
     * "shoes, shoes, shoes" reads as though something happened three times.
     */
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await withCompany(company.id, (db) =>
      db.contact.update({
        where: { id: fixture.contactId },
        data: { tags: ["shoes"] },
      }),
    );

    await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "shoes" }),
    );

    const contact = await withCompany(company.id, (db) =>
      db.contact.findFirstOrThrow({
        where: { id: fixture.contactId },
        select: { tags: true },
      }),
    );

    expect(contact.tags).toEqual(["shoes"]);
  });
});

describe("handing off", () => {
  it("ends the run and raises the thread in the inbox", async () => {
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "help" }),
    );

    const [run, conversation] = await withCompany(company.id, async (db) => [
      await db.flowRun.findFirstOrThrow({
        select: { status: true, activeConversationId: true, currentNodeId: true },
      }),
      await db.conversation.findFirstOrThrow({
        where: { id: fixture.conversationId },
        select: { unreadCount: true },
      }),
    ]);

    /* HANDED_OFF, kept apart from COMPLETED: one of them is the flow saying it
       could not finish the job. */
    expect(run.status).toBe("HANDED_OFF");
    expect(run.activeConversationId).toBeNull();
    expect(run.currentNodeId).toBeNull();

    /* Unread, or nobody picks it up: the inbox shows unread and sorts on
       last_message_at, so a handoff whose only trace is a status column is a
       conversation that sits there. */
    expect(conversation.unreadCount).toBeGreaterThan(0);
  });
});

describe("the window", () => {
  it("pauses with its position kept rather than failing", async () => {
    /*
     * The second thing this phase cannot retrofit. The customer stopped
     * replying for a day and the window shut with the run halfway down the
     * tree. Nothing has gone wrong - the flow simply cannot speak until spoken
     * to - so the position survives and the entry template can pick them up
     * where they stopped.
     */
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await withCompany(company.id, (db) =>
      db.conversation.update({
        where: { id: fixture.conversationId },
        data: { windowExpiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    const result = await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "help" }),
    );

    expect(result.outcome).toBe("paused");
    if (result.outcome !== "paused") return;
    expect(result.sends).toEqual([]);

    const run = await withCompany(company.id, (db) =>
      db.flowRun.findFirstOrThrow({
        select: {
          status: true,
          currentNodeId: true,
          activeConversationId: true,
          pausedAt: true,
        },
      }),
    );

    expect(run.status).toBe("PAUSED");
    /* The whole difference between pausing and failing. */
    expect(run.currentNodeId).toBe("menu");
    expect(run.activeConversationId).toBe(fixture.conversationId);
    expect(run.pausedAt).not.toBeNull();
  });

  it("resumes a paused run where it left off, not at the top", async () => {
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await withCompany(company.id, (db) =>
      db.flowRun.update({
        where: { id: started.runId },
        data: { status: "PAUSED", pausedAt: new Date() },
      }),
    );

    const resumed = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    expect(resumed.outcome).toBe("resumed");
    if (resumed.outcome !== "resumed") return;

    const run = await withCompany(company.id, (db) =>
      db.flowRun.findFirstOrThrow({
        select: { id: true, status: true, currentNodeId: true },
      }),
    );

    /* The SAME run, still standing on the question it never got answered. */
    expect(run.id).toBe(started.runId);
    expect(run.status).toBe("ACTIVE");
    expect(run.currentNodeId).toBe("menu");

    /* And it re-sends that question, with fresh ids naming the same node. */
    const message = await withCompany(company.id, (db) =>
      db.message.findFirstOrThrow({
        where: { id: resumed.sends[0]!.messageId },
        select: { interactivePayload: true },
      }),
    );

    const payload = message.interactivePayload as {
      action: { buttons: Array<{ reply: { id: string } }> };
    };

    expect(payload.action.buttons[0]!.reply.id).toBe(
      `f1.r.${started.runId}.menu.shoes`,
    );

    const log = await steps();
    expect(log.map((s) => s.kind)).toContain("RESUMED");
  });
});

describe("a customer who types instead of tapping", () => {
  it("hands the thread to a person rather than guessing which button they meant", async () => {
    /*
     * "yes" reads as agreement to a person and is not one to a tree. Matching
     * the label to guess is the kind of cleverness that puts somebody in the
     * wrong branch, and the branch here is the one that scores them HOT.
     */
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    const typed = await tap(null, "shoes please");

    expect(typed.outcome).toBe("declined");
    if (typed.outcome !== "declined") return;
    expect(typed.reason).toBe("not_waiting");

    const [run, contact] = await withCompany(company.id, async (db) => [
      await db.flowRun.findFirstOrThrow({ select: { status: true } }),
      await db.contact.findFirstOrThrow({
        where: { id: fixture.contactId },
        select: { leadScore: true },
      }),
    ]);

    expect(run.status).toBe("HANDED_OFF");
    /* And nothing down that branch ran. */
    expect(contact.leadScore).toBeNull();
  });

  it("ignores a typed message when no run is waiting", async () => {
    expect(await tap(null, "hello?")).toEqual({ outcome: "no_flow" });
  });
});
