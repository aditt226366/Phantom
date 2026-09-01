import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encodeEntryButtonId, encodeReplyButtonId } from "@whatsapp-os/core/flows";
import { windowExpiryFor } from "@whatsapp-os/core/whatsapp";
import {
  advanceFlow,
  clearNeedsHuman,
  countWaitingForAHuman,
  flagNeedsHuman,
  handOff,
  markConversationRead,
  waitingForAHuman,
  withCompany,
} from "../src/index.ts";
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
    {
      id: "human",
      kind: "handoff",
      body: "Someone will be in touch.",
      /* The author's own words, which become the queue's reason. */
      note: "wants help",
    },
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
        select: { needsHumanAt: true, needsHumanReason: true },
      }),
    ]);

    /* HANDED_OFF, kept apart from COMPLETED: one of them is the flow saying it
       could not finish the job. */
    expect(run.status).toBe("HANDED_OFF");
    expect(run.activeConversationId).toBeNull();
    expect(run.currentNodeId).toBeNull();

    /*
     * And the thread says a person is needed, explicitly.
     *
     * This assertion used to read `unreadCount > 0`, because the handoff faked
     * Phase 5's derivation by incrementing it. That is the bug the column
     * replaced - a status on the RUN is not something the inbox reads, and the
     * faked count was undone by anybody opening the thread.
     */
    expect(conversation.needsHumanAt).not.toBeNull();
    expect(conversation.needsHumanReason).toBe("wants help");
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

describe("a thread that needs a person", () => {
  /**
   * The state that replaced a derivation, and the bug that made it necessary.
   *
   * Phase 5 derived "needs a person" as `assigned_user_id IS NULL AND
   * unread_count > 0`, which was right while a customer writing in was the only
   * way a thread came to need somebody. A handoff node is a proactive claim,
   * and the first version faked the derivation by incrementing unread_count -
   * which markConversationRead then undid.
   */

  async function handoffFlow() {
    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );
    if (started.outcome !== "started") throw new Error("expected a run");

    await tap(
      encodeReplyButtonId({ runId: started.runId, nodeId: "menu", choice: "help" }),
    );

    return started.runId;
  }

  function conversation() {
    return withCompany(company.id, (db) =>
      db.conversation.findFirstOrThrow({
        where: { id: fixture.conversationId },
        select: {
          needsHumanAt: true,
          needsHumanReason: true,
          unreadCount: true,
          assignedUserId: true,
        },
      }),
    );
  }

  it("flags the thread with the reason the author wrote", async () => {
    await handoffFlow();
    const row = await conversation();

    expect(row.needsHumanAt).not.toBeNull();
    /* The handoff node's own note, which is the only sentence in the system
       that says what the author wanted a person to do. */
    expect(row.needsHumanReason).toBe("wants help");
  });

  it("names the node when the author wrote no note", async () => {
    /*
     * The fallback is not decoration. A flagged thread with no reason is a
     * blank cell in the queue somebody is reading to decide what to pick up,
     * and the CHECK refuses one - so a handoff drawn without a note still has
     * to say something, and where in the tree the customer stopped is the most
     * useful thing available.
     */
    await withCompany(company.id, (db) =>
      db.flowVersion.update({
        where: { id: fixture.versionId },
        data: {
          graph: {
            ...GRAPH,
            nodes: GRAPH.nodes.map((n) =>
              n.id === "start"
                ? { ...n, templateId: fixture.templateId }
                : n.id === "human"
                  ? { ...n, note: null }
                  : n,
            ),
          },
        },
      }),
    );

    await handoffFlow();
    const row = await conversation();

    expect(row.needsHumanAt).not.toBeNull();
    expect(row.needsHumanReason).toContain("did not say why");
  });

  it("survives somebody opening the thread to see why", async () => {
    /*
     * The regression this column exists for. The flag used to BE the unread
     * count, so reading the thread destroyed it: the conversation left
     * waiting-for-a-human with nobody assigned and nothing resolved, and was
     * then invisible in exactly the queue it had been put into.
     *
     * Opening a thread is how somebody decides whether they want it. A signal
     * a glance erases is not a signal.
     */
    await handoffFlow();

    await withCompany(company.id, (db, scoped) =>
      markConversationRead(db, scoped, fixture.conversationId, 99),
    );

    const row = await conversation();

    expect(row.unreadCount).toBe(0);
    expect(row.needsHumanAt).not.toBeNull();
    expect(row.needsHumanReason).toBe("wants help");
  });

  it("does not move the instant when a thread is flagged twice", async () => {
    /*
     * The queue sorts oldest first, so re-flagging must not send a thread to
     * the back. A customer who taps through into a second handoff has been
     * waiting since the first one, and that is the number the person picking
     * work up needs.
     */
    await handoffFlow();
    const first = await conversation();

    await withCompany(company.id, (db, scoped) =>
      flagNeedsHuman(db, scoped, fixture.conversationId, {
        reason: "and again",
        at: new Date(Date.now() + 60_000),
      }),
    );

    const second = await conversation();

    expect(second.needsHumanAt).toEqual(first.needsHumanAt);
    /* The reason IS updated - the newest one is the most useful sentence. */
    expect(second.needsHumanReason).toBe("and again");
  });

  it("clears both columns together, because the CHECK requires it", async () => {
    await handoffFlow();

    await withCompany(company.id, (db, scoped) =>
      clearNeedsHuman(db, scoped, fixture.conversationId),
    );

    const row = await conversation();

    expect(row.needsHumanAt).toBeNull();
    expect(row.needsHumanReason).toBeNull();
  });

  it("refuses a flag with no reason", async () => {
    /*
     * A flagged thread with no reason renders as a blank cell in the queue
     * somebody is reading to decide what to pick up.
     */
    await expect(
      withCompany(company.id, (db) =>
        db.conversation.updateMany({
          where: { id: fixture.conversationId },
          data: { needsHumanAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a reason with no flag", async () => {
    await expect(
      withCompany(company.id, (db) =>
        db.conversation.updateMany({
          where: { id: fixture.conversationId },
          data: { needsHumanReason: "orphaned" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("does not raise the unread count, because no message arrived", async () => {
    /*
     * unread_count means inbound messages nobody here has read. A flow deciding
     * by itself that a person is needed produces no such message, and saying
     * otherwise put a number on a badge that nothing in the thread explained.
     */
    await handoffFlow();
    const row = await conversation();

    /* The customer's own taps are inbound and DO count; what is asserted here
       is that the handoff added nothing on top of them. */
    const inbound = await withCompany(company.id, (db) =>
      db.message.count({
        where: { conversationId: fixture.conversationId, direction: "INBOUND" },
      }),
    );

    expect(row.unreadCount).toBeLessThanOrEqual(inbound);
  });

  it("flags on a notify step without ending the run", async () => {
    /*
     * notify had the identical defect and shares the fix. Unlike a handoff it
     * does not end the run: the flow carries on and the thread is flagged
     * beside it.
     */
    await withCompany(company.id, (db) =>
      db.flowVersion.update({
        where: { id: fixture.versionId },
        data: {
          graph: {
            entryNodeId: "start",
            nodes: [
              {
                id: "start",
                kind: "entry",
                templateId: fixture.templateId,
                variables: [],
                choices: [{ key: "yes", label: "Yes please", next: "shout" }],
              },
              {
                id: "shout",
                kind: "action",
                actions: [{ kind: "notify", note: "Asked about bulk pricing." }],
                next: "ask",
              },
              {
                id: "ask",
                kind: "question",
                body: "How many are you after?",
                variable: null,
                presentation: {
                  as: "buttons",
                  choices: [{ key: "lots", label: "A lot", next: null }],
                },
              },
            ],
          },
        },
      }),
    );

    const started = await tap(
      encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
      "Yes please",
    );

    expect(started.outcome).toBe("started");

    const [row, run] = await withCompany(company.id, async (db) => [
      await db.conversation.findFirstOrThrow({
        where: { id: fixture.conversationId },
        select: { needsHumanAt: true, needsHumanReason: true },
      }),
      await db.flowRun.findFirstOrThrow({ select: { status: true } }),
    ]);

    expect(row.needsHumanReason).toBe("Asked about bulk pricing.");
    /* Still running - the flag and the ending are two decisions. */
    expect(run.status).toBe("ACTIVE");
  });

  it("does not flag when an operator's own reply ends the run", async () => {
    /*
     * handOff has two callers meaning opposite things. A flow that could not
     * understand a typed reply wants somebody; an operator who has just replied
     * IS somebody. Flagging there would put a request for a person into the
     * queue in front of the person who had already taken the thread, and bounce
     * it back every time they answered again.
     */
    const runId = await (async () => {
      const started = await tap(
        encodeEntryButtonId({ versionId: fixture.versionId, nodeId: "start" }),
        "Yes please",
      );
      if (started.outcome !== "started") throw new Error("expected a run");
      return started.runId;
    })();

    await handOff(company.id, runId, "Someone from the team replied.", false);

    const [row, run] = await withCompany(company.id, async (db) => [
      await db.conversation.findFirstOrThrow({
        where: { id: fixture.conversationId },
        select: { needsHumanAt: true },
      }),
      await db.flowRun.findFirstOrThrow({ select: { status: true } }),
    ]);

    expect(run.status).toBe("HANDED_OFF");
    expect(row.needsHumanAt).toBeNull();
  });
});

describe("the waiting-for-a-human queue", () => {
  /**
   * The read site Phase 5 wrote and the flow builder broke.
   *
   * It had no test at all before this, which is part of how the handoff shipped
   * satisfying neither of its clauses: nothing asserted what the queue was
   * supposed to contain, so nothing noticed when a new writer produced threads
   * it could not see.
   */

  it("includes a thread nobody has taken with unread messages", async () => {
    /* Phase 5's clause, unchanged and still doing its job. */
    await withCompany(company.id, (db, scoped) =>
      db.conversation.updateMany({
        where: { id: fixture.conversationId, companyId: scoped },
        data: { unreadCount: 2, assignedUserId: null },
      }),
    );

    const rows = await withCompany(company.id, (db) => waitingForAHuman(db));

    expect(rows.map((r) => r.conversationId)).toContain(fixture.conversationId);
    /* No reason, because nobody claimed anything - the customer simply wrote. */
    expect(rows[0]?.needsHumanReason).toBeNull();
  });

  it("includes a flagged thread with nothing unread and nobody assigned", async () => {
    /*
     * The case the derivation could not express, and the whole reason for the
     * column. A flow decides by itself that a person is needed: no message
     * arrived, so nothing is unread, and the old predicate saw nothing.
     */
    await withCompany(company.id, (db, scoped) =>
      db.conversation.updateMany({
        where: { id: fixture.conversationId, companyId: scoped },
        data: { unreadCount: 0, assignedUserId: null },
      }),
    );

    await withCompany(company.id, (db, scoped) =>
      flagNeedsHuman(db, scoped, fixture.conversationId, {
        reason: "Wants a bulk price",
        at: new Date("2026-09-07T09:00:00Z"),
      }),
    );

    const rows = await withCompany(company.id, (db) => waitingForAHuman(db));
    const row = rows.find((r) => r.conversationId === fixture.conversationId);

    expect(row).toBeDefined();
    expect(row?.unreadCount).toBe(0);
    /* The card shows this instead of the preview - for a handoff the last
       message is the flow's own goodbye and says nothing about what is wanted. */
    expect(row?.needsHumanReason).toBe("Wants a bulk price");
  });

  it("keeps a flagged thread even once somebody is assigned to it", async () => {
    /*
     * Assignment is what CLEARS the flag, by writing the column. Until that
     * happens the stored state is the one that is true, and a queue that
     * hid the row on assignment alone would drop a request nothing resolved.
     */
    await withCompany(company.id, (db, scoped) =>
      flagNeedsHuman(db, scoped, fixture.conversationId, {
        reason: "Wants a bulk price",
        at: new Date("2026-09-07T09:00:00Z"),
      }),
    );

    await withCompany(company.id, (db, scoped) =>
      db.conversation.updateMany({
        where: { id: fixture.conversationId, companyId: scoped },
        data: { unreadCount: 0, assignedUserId: company.userIds[0]! },
      }),
    );

    const rows = await withCompany(company.id, (db) => waitingForAHuman(db));

    expect(rows.map((r) => r.conversationId)).toContain(fixture.conversationId);
  });

  it("drops it once the flag is cleared", async () => {
    await withCompany(company.id, (db, scoped) =>
      flagNeedsHuman(db, scoped, fixture.conversationId, {
        reason: "Wants a bulk price",
        at: new Date("2026-09-07T09:00:00Z"),
      }),
    );

    await withCompany(company.id, (db, scoped) =>
      db.conversation.updateMany({
        where: { id: fixture.conversationId, companyId: scoped },
        data: { unreadCount: 0, assignedUserId: null },
      }),
    );

    await withCompany(company.id, (db, scoped) =>
      clearNeedsHuman(db, scoped, fixture.conversationId),
    );

    const rows = await withCompany(company.id, (db) => waitingForAHuman(db));

    expect(rows.map((r) => r.conversationId)).not.toContain(
      fixture.conversationId,
    );
  });

  it("counts exactly what it lists", async () => {
    /*
     * The card and its badge MUST read the same predicate. Two copies is how a
     * page ends up saying "3" above a list of five, and the discrepancy is
     * invisible until somebody counts - at which point the number nobody
     * trusts is the one they were meant to act on.
     */
    await withCompany(company.id, (db, scoped) =>
      flagNeedsHuman(db, scoped, fixture.conversationId, {
        reason: "Wants a bulk price",
        at: new Date("2026-09-07T09:00:00Z"),
      }),
    );

    const [rows, total] = await withCompany(company.id, async (db) => [
      await waitingForAHuman(db),
      await countWaitingForAHuman(db),
    ]);

    expect(total).toBe(rows.length);
  });
});
