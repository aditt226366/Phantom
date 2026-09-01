import {
  MAX_STEPS_PER_RUN,
  flowGraphSchema,
  buildInteractivePayload,
  describeInteractive,
  encodeEntryButtonId,
  parseButtonId,
  planAdvance,
  planEntry,
  type AdvancePlan,
  type FlowAction,
  type FlowEffect,
  type FlowGraph,
  type FlowInput,
} from "@whatsapp-os/core/flows";
import { describeWindow, isWindowOpen } from "@whatsapp-os/core/whatsapp";
import { materialiseFlowMessage } from "./outbound.ts";
import { withCompany, type CompanyClient } from "./with-company.ts";

/**
 * Turning one inbound message into a run's next position.
 *
 * ===========================================================================
 * Everything here is about refusing to act on a tap that means nothing
 * ===========================================================================
 *
 * WhatsApp buttons never expire in the chat. A customer scrolls up three days,
 * taps "Yes" on a message from a flow that finished on Tuesday, and the payload
 * arrives here looking exactly like a live answer. The naive runtime advances
 * whatever run the conversation currently has, from wherever it currently is,
 * and the customer receives the next question of a conversation they were not
 * having - or worse, an action node fires and their lead score is rewritten by
 * a three-day-old tap.
 *
 * So this file's shape is a sequence of refusals, and each one is recorded
 * rather than dropped. A DECLINED step in the log is what turns "the bot
 * ignored me" into an answerable question.
 *
 * ===========================================================================
 * Why the engine is somewhere else
 * ===========================================================================
 *
 * planAdvance decides; this executes. The split is what lets the ceiling, the
 * routing and the determinism be asserted as values rather than provoked
 * through a fixture - and it means the part of the system that can fail (a
 * message that will not send, a row that will not write) is separate from the
 * part that has to be predictable.
 */

/** Why a tap was acknowledged and not obeyed. Codes, never prose. */
export type FlowDecline =
  /** The payload was not written by this system. Somebody else's button. */
  | "not_ours"
  /** Our scheme tag, unreadable after that. */
  | "malformed"
  /** The run in the id does not exist, or belongs to another company. */
  | "unknown_run"
  /** The run has ended. The commonest stale tap by far. */
  | "run_ended"
  /**
   * The run exists and is live, and the tap names a node it has already left.
   *
   * The one this whole design is for. Without the node in the id every tap
   * looks current, and there is no way to tell a real answer from a customer
   * scrolling up.
   */
  | "stale_node"
  /** The entry names a version that is not the flow's published one. */
  | "version_unpublished"
  /** The version's stored graph no longer parses. Refuse rather than guess. */
  | "unreadable_version"
  /** An entry tap arrived while a run is already live and waiting. */
  | "run_already_active"
  /** The customer typed at a node that wanted a tap. Handed to a person. */
  | "not_waiting";

export interface FlowAdvanceInput {
  conversationId: string;
  /** The inbound message that triggered this. Recorded on the step. */
  messageId: string;
  /** The button or list-row id, when the customer tapped one. */
  replyId: string | null;
  /** What they typed, when they typed. */
  text: string | null;
  occurredAt: Date;
}

/** A message the caller has to hand to the send queue, once no scope is open. */
export interface FlowSendRequest {
  messageId: string;
  sendAttempt: number;
}

export type FlowAdvanceResult =
  /** Nothing here is in a flow. The ordinary case for most inbound messages. */
  | { outcome: "no_flow" }
  | { outcome: "declined"; reason: FlowDecline; runId: string | null }
  | {
      outcome: "started" | "advanced" | "resumed" | "paused" | "ended" | "failed";
      runId: string;
      sends: FlowSendRequest[];
    };

/** Statuses a run can still be advanced from. */
const LIVE = ["ACTIVE", "PAUSED"] as const;

/**
 * Read a version's stored tree.
 *
 * Parsed rather than cast, every time it is read. The column is jsonb and holds
 * whatever was written, and a version whose graph no longer satisfies the
 * schema is a run that would walk into undefined - so this refuses and the tap
 * is declined with a reason, which is a support conversation rather than a
 * customer receiving something incoherent.
 */
function readGraph(raw: unknown): FlowGraph | null {
  const parsed = flowGraphSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Advance whatever this conversation is doing, if anything.
 *
 * Called once per inserted inbound message. Most of the time the answer is
 * no_flow, which is why the cheap checks come first.
 */
export async function advanceFlow(
  companyId: string,
  input: FlowAdvanceInput,
): Promise<FlowAdvanceResult> {
  const ref = input.replyId ? parseButtonId(input.replyId) : null;

  /*
   * A payload that is not ours is not an error and must not be recorded as
   * one. A customer with two vendors in their WhatsApp taps somebody else's
   * button and it lands in our webhook; counting that would make a flow's
   * decline count a count of other people's buttons.
   */
  if (ref && !ref.ok && ref.reason === "not_ours") {
    return { outcome: "no_flow" };
  }

  if (ref && !ref.ok) {
    return { outcome: "declined", reason: ref.reason, runId: null };
  }

  if (ref?.ok && ref.ref.kind === "entry") {
    return startOrResume(companyId, input, ref.ref.versionId, ref.ref.nodeId);
  }

  if (ref?.ok && ref.ref.kind === "reply") {
    return continueRun(companyId, input, ref.ref.runId, ref.ref.nodeId, {
      kind: "choice",
      key: ref.ref.choice,
    });
  }

  /*
   * No button at all: the customer typed. Only interesting if this
   * conversation has a run waiting on a collect node.
   */
  if (input.text === null) return { outcome: "no_flow" };

  const live = await withCompany(companyId, (db) =>
    db.flowRun.findFirst({
      where: { activeConversationId: input.conversationId },
      select: { id: true, currentNodeId: true },
    }),
  );

  if (!live?.currentNodeId) return { outcome: "no_flow" };

  return continueRun(companyId, input, live.id, live.currentNodeId, {
    kind: "text",
    value: input.text,
  });
}

/**
 * A tap on an approved template's quick reply.
 *
 * Three outcomes, and the middle one is the phase's second unretrofittable
 * decision. A paused run is picked up where it left off rather than started
 * again - the position was kept for exactly this moment, and starting again
 * would make the customer answer three questions they have already answered.
 */
async function startOrResume(
  companyId: string,
  input: FlowAdvanceInput,
  versionId: string,
  entryNodeId: string,
): Promise<FlowAdvanceResult> {
  const loaded = await withCompany(companyId, async (db) => {
    const version = await db.flowVersion.findFirst({
      where: { id: versionId },
      select: {
        id: true,
        flowId: true,
        graph: true,
        publishedAt: true,
        flow: { select: { publishedVersionId: true, archivedAt: true } },
      },
    });

    const conversation = await db.conversation.findFirst({
      where: { id: input.conversationId },
      select: { id: true, contactId: true, windowExpiresAt: true },
    });

    const existing = await db.flowRun.findFirst({
      where: { activeConversationId: input.conversationId },
      select: { id: true, status: true, currentNodeId: true, flowVersionId: true },
    });

    return { version, conversation, existing };
  });

  if (!loaded.version || !loaded.conversation) {
    return { outcome: "declined", reason: "unknown_run", runId: null };
  }

  /*
   * Published, and still the flow's live version.
   *
   * Both halves. publishedAt alone would let a superseded version start new
   * runs for as long as its template sat in somebody's chat - which is the
   * whole hazard: the template was sent last month, the tenant has published
   * twice since, and a tap today must not open a conversation the tenant
   * stopped having.
   */
  const published =
    loaded.version.publishedAt !== null &&
    loaded.version.flow.publishedVersionId === loaded.version.id &&
    loaded.version.flow.archivedAt === null;

  if (!published) {
    return { outcome: "declined", reason: "version_unpublished", runId: null };
  }

  /* Resume before start: the paused run owns this conversation's slot. */
  if (loaded.existing) {
    if (loaded.existing.status === "ACTIVE") {
      /*
       * A live run already has a question in front of this customer, and the
       * window is open because they just tapped. Re-sending the entry would
       * charge the tenant for a template to somebody who can answer for free.
       */
      return {
        outcome: "declined",
        reason: "run_already_active",
        runId: loaded.existing.id,
      };
    }

    return resumePausedRun(companyId, input, loaded.existing.id);
  }

  const graph = readGraph(loaded.version.graph);
  if (!graph) {
    return { outcome: "declined", reason: "unreadable_version", runId: null };
  }

  /*
   * The choice key is not in the entry payload - a template's quick reply
   * carries one payload per BUTTON, and the button index is the choice. The id
   * names the entry node, and the button that was tapped is identified by the
   * payload we put on it, so the key is the one whose encoded id matches.
   *
   * Resolved by re-encoding rather than by parsing a fourth field, because the
   * entry id has no run to name and adding one would mean creating a run for
   * every recipient of a ten-thousand-person broadcast, most of whom never tap.
   */
  const entryNode = graph.nodes.find((n) => n.id === entryNodeId);
  if (!entryNode || entryNode.kind !== "entry" || entryNode.choices.length === 0) {
    return { outcome: "declined", reason: "unreadable_version", runId: null };
  }

  /*
   * Which button. Meta gives us the payload we wrote, and every button of one
   * entry node carries the same encoded id - so the tapped choice is read from
   * the message's own text, and when that is absent the first choice is taken.
   *
   * The first choice rather than a refusal, because a single-button entry is
   * the common shape and refusing it would break the simplest flow anybody
   * builds. A multi-button entry whose text did not arrive is declined below
   * instead of guessed at.
   */
  const chosen =
    entryNode.choices.find((c) => c.label === input.text) ??
    (entryNode.choices.length === 1 ? entryNode.choices[0]! : null);

  if (!chosen) {
    return { outcome: "declined", reason: "unreadable_version", runId: null };
  }

  const plan = planEntry(graph, entryNodeId, chosen.key);

  const run = await withCompany(companyId, (db, scoped) =>
    db.flowRun.create({
      data: {
        companyId: scoped,
        flowId: loaded.version!.flowId,
        flowVersionId: loaded.version!.id,
        conversationId: loaded.conversation!.id,
        activeConversationId: loaded.conversation!.id,
        contactId: loaded.conversation!.contactId,
        /*
         * Starts standing on the entry node, which the CHECK requires and
         * which is also true: the customer has just answered it.
         */
        currentNodeId: entryNodeId,
        variables: {},
      },
      select: { id: true },
    }),
  );

  await appendStep(companyId, run.id, {
    kind: "STARTED",
    nodeId: entryNodeId,
    choice: chosen.key,
    messageId: input.messageId,
  });

  const result = await execute(companyId, {
    runId: run.id,
    conversationId: loaded.conversation.id,
    contactId: loaded.conversation.contactId,
    windowExpiresAt: loaded.conversation.windowExpiresAt,
    plan,
    occurredAt: input.occurredAt,
    fromNodeId: entryNodeId,
    choice: chosen.key,
    inboundMessageId: input.messageId,
  });

  return result.outcome === "advanced" ? { ...result, outcome: "started" } : result;
}

/**
 * Pick a paused run up where it left off.
 *
 * It keeps its position, so resuming means re-sending the node it is standing
 * on rather than walking anywhere. The customer sees the question they never
 * got to answer, with fresh button ids naming the same run and node - which is
 * what makes the old ids stale rather than ambiguous.
 */
async function resumePausedRun(
  companyId: string,
  input: FlowAdvanceInput,
  runId: string,
): Promise<FlowAdvanceResult> {
  const loaded = await loadRun(companyId, runId);

  if (!loaded || !loaded.run.currentNodeId) {
    return { outcome: "declined", reason: "unknown_run", runId };
  }

  const node = loaded.graph.nodes.find((n) => n.id === loaded.run.currentNodeId);

  if (!node) {
    /* The version was pinned, so this should be impossible. Refuse loudly. */
    return { outcome: "declined", reason: "unreadable_version", runId };
  }

  await withCompany(companyId, (db) =>
    db.flowRun.update({
      where: { id: runId },
      data: { status: "ACTIVE", lastError: null },
    }),
  );

  await appendStep(companyId, runId, {
    kind: "RESUMED",
    nodeId: node.id,
    messageId: input.messageId,
  });

  const sends = await emit(companyId, {
    runId,
    conversationId: loaded.run.conversationId,
    contactId: loaded.run.contactId,
    effects: [{ kind: "send", node }],
    occurredAt: input.occurredAt,
  });

  return { outcome: "resumed", runId, sends };
}

/**
 * A tap or a typed reply inside a run that already exists.
 *
 * The three refusals here are the stale-press guard, in order of how often each
 * one fires in practice.
 */
async function continueRun(
  companyId: string,
  input: FlowAdvanceInput,
  runId: string,
  fromNodeId: string,
  answer: FlowInput,
): Promise<FlowAdvanceResult> {
  const loaded = await loadRun(companyId, runId);

  /*
   * No row, or another company's. Not found rather than forbidden, and for the
   * reason CLAUDE.md rule 6 gives: a different answer here would confirm that
   * a run with that id exists.
   */
  if (!loaded) {
    return { outcome: "declined", reason: "unknown_run", runId: null };
  }

  if (!LIVE.includes(loaded.run.status as (typeof LIVE)[number])) {
    /*
     * The commonest stale tap. The flow finished on Tuesday and the buttons
     * are still sitting in the chat, so a customer scrolling back finds them
     * and they look live.
     */
    await recordDecline(companyId, runId, "run_ended", fromNodeId, input);
    return { outcome: "declined", reason: "run_ended", runId };
  }

  if (loaded.run.currentNodeId !== fromNodeId) {
    /*
     * The one the encoding exists for. The run is live and standing somewhere
     * else, so this tap answered a question it has already moved past - and
     * obeying it would advance a different conversation on the strength of an
     * old press.
     */
    await recordDecline(companyId, runId, "stale_node", fromNodeId, input);
    return { outcome: "declined", reason: "stale_node", runId };
  }

  if (loaded.run.stepCount >= MAX_STEPS_PER_RUN) {
    await failRun(companyId, runId, "This flow ran for too many steps and was stopped.");
    return { outcome: "failed", runId, sends: [] };
  }

  const variables = readVariables(loaded.run.variables);
  const plan = planAdvance(loaded.graph, fromNodeId, answer, variables);

  /*
   * A typed reply to a question with buttons. The customer wrote "yes" instead
   * of tapping Yes, which reads as agreement to a person and is not one to a
   * tree. Handed to a person rather than guessed at: matching the label would
   * put somebody in the wrong branch, and the thread is the right place for it.
   */
  if (!plan.ok && plan.reason === "not_waiting") {
    await handOff(companyId, runId, "The customer replied in their own words.");
    await recordDecline(companyId, runId, "not_waiting", fromNodeId, input);
    return { outcome: "declined", reason: "not_waiting", runId };
  }

  /* A paused run answering means the window is open again. */
  if (loaded.run.status === "PAUSED") {
    await withCompany(companyId, (db) =>
      db.flowRun.update({
        where: { id: runId },
        data: { status: "ACTIVE", lastError: null },
      }),
    );
    await appendStep(companyId, runId, {
      kind: "RESUMED",
      nodeId: fromNodeId,
      messageId: input.messageId,
    });
  }

  return execute(companyId, {
    runId,
    conversationId: loaded.run.conversationId,
    contactId: loaded.run.contactId,
    windowExpiresAt: loaded.conversation.windowExpiresAt,
    plan,
    occurredAt: input.occurredAt,
    fromNodeId,
    choice: answer.kind === "choice" ? answer.key : null,
    inboundMessageId: input.messageId,
  });
}

interface ExecuteInput {
  runId: string;
  conversationId: string;
  contactId: string;
  windowExpiresAt: Date | null;
  plan: AdvancePlan;
  occurredAt: Date;
  fromNodeId: string;
  choice: string | null;
  inboundMessageId: string;
}

/**
 * Carry out a plan, or refuse to.
 *
 * The window check is here AS WELL AS in the send path, and the two are not
 * redundant. This one is the difference between a run that pauses with its
 * position kept and a run that queues four messages Meta will refuse one at a
 * time - so the customer sees nothing, the thread fills with failures, and the
 * operator has to work out that a deadline passed. The send path's check is the
 * boundary, because the window can close between here and the Graph call.
 */
async function execute(
  companyId: string,
  input: ExecuteInput,
): Promise<FlowAdvanceResult> {
  const { plan, runId } = input;

  if (!plan.ok) {
    if (plan.reason === "step_ceiling") {
      await failRun(companyId, runId, "This flow ran for too many steps and was stopped.");
      return { outcome: "failed", runId, sends: [] };
    }

    await recordDecline(companyId, runId, "stale_node", input.fromNodeId, {
      messageId: input.inboundMessageId,
      replyId: null,
    });

    return { outcome: "declined", reason: "stale_node", runId };
  }

  const window = describeWindow(input.windowExpiresAt, input.occurredAt);
  const sending = plan.effects.some((e) => e.kind === "send");

  if (sending && !isWindowOpen(window)) {
    /*
     * Paused, not failed. Nothing has gone wrong: the flow simply cannot speak
     * until spoken to, and the position is kept so the entry template can pick
     * the customer up exactly where they stopped.
     */
    await pauseRun(companyId, runId, input.occurredAt);
    return { outcome: "paused", runId, sends: [] };
  }

  await appendStep(companyId, runId, {
    kind: "ADVANCED",
    nodeId: input.fromNodeId,
    choice: input.choice,
    messageId: input.inboundMessageId,
    detail: { variables: plan.variables },
  });

  const sends = await emit(companyId, {
    runId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    effects: plan.effects,
    occurredAt: input.occurredAt,
  });

  if (plan.position.kind === "waiting") {
    await withCompany(companyId, (db) =>
      db.flowRun.update({
        where: { id: runId },
        data: {
          currentNodeId: plan.position.kind === "waiting" ? plan.position.nodeId : null,
          variables: plan.variables,
        },
      }),
    );

    return { outcome: "advanced", runId, sends };
  }

  await withCompany(companyId, (db) =>
    db.flowRun.update({
      where: { id: runId },
      data: {
        status: plan.position.kind === "ended" ? plan.position.status : "COMPLETED",
        variables: plan.variables,
        /* All three together, because the CHECKs require them to agree. */
        currentNodeId: null,
        activeConversationId: null,
        endedAt: input.occurredAt,
      },
    }),
  );

  return { outcome: "ended", runId, sends };
}

interface EmitInput {
  runId: string;
  conversationId: string;
  contactId: string;
  effects: readonly FlowEffect[];
  occurredAt: Date;
}

/**
 * Turn effects into rows.
 *
 * Every send goes through materialiseFlowMessage, which is the shared producer
 * - the opt-out filter and the conversation advance come with it rather than
 * being remembered here.
 */
async function emit(companyId: string, input: EmitInput): Promise<FlowSendRequest[]> {
  const sends: FlowSendRequest[] = [];

  for (const effect of input.effects) {
    if (effect.kind === "wait") continue;

    if (effect.kind === "act") {
      const applied = await applyActions(
        companyId,
        input.runId,
        input.contactId,
        input.conversationId,
        effect.node.actions,
      );

      await appendStep(companyId, input.runId, {
        kind: "ACTION",
        nodeId: effect.node.id,
        detail: { actions: applied },
      });
      continue;
    }

    const node = effect.node;

    if (effect.kind === "finish") {
      await appendStep(companyId, input.runId, {
        kind: "ENDED",
        nodeId: node.id,
        detail: {
          status: effect.status,
          ...(node.kind === "handoff" && node.note ? { note: node.note } : {}),
        },
      });

      if (node.kind === "handoff") {
        /*
         * Raise the thread. A handoff whose only trace is a status column is a
         * conversation nobody picks up: the inbox sorts on last_message_at and
         * shows unread, so the thread has to be unread for a person to see it.
         */
        await withCompany(companyId, (db) =>
          db.conversation.update({
            where: { id: input.conversationId },
            data: { unreadCount: { increment: 1 } },
          }),
        );
      }
      continue;
    }

    /* A send. Questions carry buttons; everything else is words. */
    const interactive =
      node.kind === "question" ? buildInteractivePayload(node, input.runId) : null;

    const body =
      node.kind === "question"
        ? describeInteractive(node)
        : "body" in node && typeof node.body === "string"
          ? node.body
          : "";

    if (body.length === 0 && !interactive) continue;

    const message = await withCompany(companyId, (db, scoped) =>
      materialiseFlowMessage(db, scoped, {
        conversationId: input.conversationId,
        contactId: input.contactId,
        renderedBody: body,
        interactive,
        ...(node.kind === "message" && node.mediaId ? { mediaId: node.mediaId } : {}),
        occurredAt: input.occurredAt,
      }),
    );

    if (!message) {
      /*
       * The contact opted out between one question and the next. Not an error
       * and not a failure of the flow - they have left, so the run ends.
       */
      await appendStep(companyId, input.runId, {
        kind: "ENDED",
        nodeId: node.id,
        detail: { status: "COMPLETED", reason: "contact_unreachable" },
      });
      break;
    }

    await appendStep(companyId, input.runId, {
      kind: "SENT",
      nodeId: node.id,
      messageId: message.messageId,
    });

    sends.push(message);
  }

  return sends;
}

/**
 * What an action node writes down.
 *
 * Returned as well as applied, so the step log records what actually happened
 * rather than what was asked for - the two differ when a tag is already there.
 */
async function applyActions(
  companyId: string,
  runId: string,
  contactId: string,
  conversationId: string,
  actions: readonly FlowAction[],
): Promise<unknown[]> {
  const applied: unknown[] = [];

  for (const action of actions) {
    if (action.kind === "set_score") {
      await withCompany(companyId, (db) =>
        db.contact.update({
          where: { id: contactId },
          data: {
            leadScore: action.score,
            leadScoreAt: new Date(),
            leadScoreRunId: runId,
          },
        }),
      );
      applied.push({ kind: "set_score", score: action.score });
      continue;
    }

    if (action.kind === "add_tag") {
      /*
       * Read then write rather than an array append, because the tag must not
       * appear twice: a customer going round a menu loop three times would
       * otherwise carry the same label three times, and the contact card would
       * read as though something had happened three times.
       */
      const contact = await withCompany(companyId, (db) =>
        db.contact.findFirst({ where: { id: contactId }, select: { tags: true } }),
      );

      const tags = contact?.tags ?? [];

      if (!tags.includes(action.tag)) {
        await withCompany(companyId, (db) =>
          db.contact.update({
            where: { id: contactId },
            data: { tags: [...tags, action.tag] },
          }),
        );
      }

      applied.push({ kind: "add_tag", tag: action.tag, added: !tags.includes(action.tag) });
      continue;
    }

    /*
     * notify. Raises the thread in the inbox and records the note.
     *
     * Deliberately not an email or a push - neither exists in this system, and
     * an action node that silently did nothing would be the worst kind of
     * automation: an author draws it, believes somebody was told, and finds out
     * from a customer.
     */
    await withCompany(companyId, (db) =>
      db.conversation.update({
        where: { id: conversationId },
        data: { unreadCount: { increment: 1 } },
      }),
    );
    applied.push({ kind: "notify", note: action.note });
  }

  return applied;
}

interface LoadedRun {
  run: {
    id: string;
    status: string;
    currentNodeId: string | null;
    conversationId: string;
    contactId: string;
    variables: unknown;
    stepCount: number;
  };
  conversation: { windowExpiresAt: Date | null };
  graph: FlowGraph;
}

/**
 * A run and the tree it is PINNED to.
 *
 * The graph comes from flow_runs.flow_version_id and never from the flow's
 * published version. That one join is the version pinning: a tenant who edits
 * and republishes while a customer is three questions deep does not move that
 * customer, because this read cannot see what was published - only what the run
 * started on.
 */
async function loadRun(companyId: string, runId: string): Promise<LoadedRun | null> {
  const row = await withCompany(companyId, (db) =>
    db.flowRun.findFirst({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        currentNodeId: true,
        conversationId: true,
        contactId: true,
        variables: true,
        stepCount: true,
        flowVersion: { select: { graph: true } },
        conversation: { select: { windowExpiresAt: true } },
      },
    }),
  );

  if (!row) return null;

  const graph = readGraph(row.flowVersion.graph);
  if (!graph) return null;

  return {
    run: {
      id: row.id,
      status: row.status,
      currentNodeId: row.currentNodeId,
      conversationId: row.conversationId,
      contactId: row.contactId,
      variables: row.variables,
      stepCount: row.stepCount,
    },
    conversation: row.conversation,
    graph,
  };
}

/** Stored answers, defensively. jsonb holds whatever was written. */
function readVariables(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Append one step, and move the run's counter with it.
 *
 * seq comes from step_count in the same transaction, and the unique on
 * (company_id, flow_run_id, seq) is what makes that safe: two writers racing
 * both read 4, both try to write step 5, and one of them loses rather than both
 * claiming the same position.
 */
async function appendStep(
  companyId: string,
  runId: string,
  step: {
    kind:
      | "STARTED"
      | "SENT"
      | "ADVANCED"
      | "ACTION"
      | "PAUSED"
      | "RESUMED"
      | "DECLINED"
      | "ENDED"
      | "FAILED";
    nodeId?: string | null;
    choice?: string | null;
    messageId?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await withCompany(companyId, async (db, scoped) => {
    const run = await db.flowRun.update({
      where: { id: runId },
      data: { stepCount: { increment: 1 } },
      select: { stepCount: true },
    });

    await db.flowRunStep.create({
      data: {
        companyId: scoped,
        flowRunId: runId,
        seq: run.stepCount,
        kind: step.kind,
        nodeId: step.nodeId ?? null,
        choice: step.choice ?? null,
        messageId: step.messageId ?? null,
        detail: (step.detail ?? {}) as never,
      },
    });
  });
}

/**
 * Write down a tap we refused.
 *
 * Recorded rather than dropped, and this is the half that makes the refusal
 * defensible. "The bot ignored me" is unanswerable without it; with it, the
 * thread's own history says a tap arrived for a node the run had already left,
 * and when.
 */
async function recordDecline(
  companyId: string,
  runId: string,
  reason: FlowDecline,
  nodeId: string,
  input: Pick<FlowAdvanceInput, "messageId" | "replyId">,
): Promise<void> {
  await appendStep(companyId, runId, {
    kind: "DECLINED",
    nodeId,
    messageId: input.messageId,
    detail: { reason, ...(input.replyId ? { replyId: input.replyId } : {}) },
  });
}

/** The window shut. Position kept, which is the whole point. */
async function pauseRun(
  companyId: string,
  runId: string,
  at: Date,
): Promise<void> {
  await withCompany(companyId, (db) =>
    db.flowRun.update({
      where: { id: runId },
      data: {
        status: "PAUSED",
        pausedAt: at,
        lastError: null,
        /* currentNodeId and activeConversationId are deliberately untouched.
           PAUSED is a live status, and both CHECKs require them set. */
      },
    }),
  );

  await appendStep(companyId, runId, {
    kind: "PAUSED",
    detail: { reason: "window_closed" },
  });
}

/**
 * Stop the run and put the thread in front of a person.
 *
 * Exported because the send worker needs it too: a flow message Meta refuses
 * for a reason no retry fixes is a conversation a person has to take over.
 */
export async function handOff(
  companyId: string,
  runId: string,
  reason: string,
): Promise<void> {
  const run = await withCompany(companyId, (db) =>
    db.flowRun.findFirst({
      where: { id: runId },
      select: { conversationId: true, status: true },
    }),
  );

  if (!run || !LIVE.includes(run.status as (typeof LIVE)[number])) return;

  await withCompany(companyId, async (db) => {
    await db.flowRun.update({
      where: { id: runId },
      data: {
        status: "HANDED_OFF",
        currentNodeId: null,
        activeConversationId: null,
        endedAt: new Date(),
        lastError: reason,
      },
    });

    await db.conversation.update({
      where: { id: run.conversationId },
      data: { unreadCount: { increment: 1 } },
    });
  });

  await appendStep(companyId, runId, {
    kind: "ENDED",
    detail: { status: "HANDED_OFF", reason },
  });
}

/** Something the run cannot recover from. FAILED, never PAUSED. */
async function failRun(
  companyId: string,
  runId: string,
  reason: string,
): Promise<void> {
  await withCompany(companyId, (db) =>
    db.flowRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        currentNodeId: null,
        activeConversationId: null,
        endedAt: new Date(),
        lastError: reason,
      },
    }),
  );

  await appendStep(companyId, runId, { kind: "FAILED", detail: { reason } });
}

/**
 * The send path found the window shut on a flow's message.
 *
 * The second trigger for a pause, and the one that catches what the executor's
 * pre-check cannot: the window can close between a step being planned and the
 * queue reaching it. Without this the run sits ACTIVE for ever beside a thread
 * of POLICY failures, and the tenant's only signal is the red bubble.
 *
 * Finds the run through the step that produced the message, which is the link
 * flow_run_steps.message_id exists for.
 */
export async function pauseRunForMessage(
  companyId: string,
  messageId: string,
): Promise<string | null> {
  const step = await withCompany(companyId, (db) =>
    db.flowRunStep.findFirst({
      where: { messageId, kind: "SENT" },
      select: { flowRunId: true, flowRun: { select: { status: true } } },
    }),
  );

  if (!step) return null;
  if (!LIVE.includes(step.flowRun.status as (typeof LIVE)[number])) return null;

  await pauseRun(companyId, step.flowRunId, new Date());
  return step.flowRunId;
}

/**
 * Send a flow's entry template to somebody, so a tap can start a run.
 *
 * The producer half of the lead-source FLOW action and of anything else that
 * wants to open a flow. No run is created: the payloads name the version, and a
 * run appears when somebody actually taps. Ten thousand entry templates must
 * not become ten thousand runs for people who will mostly never answer.
 */
export async function entryButtonPayloads(
  db: CompanyClient,
  versionId: string,
): Promise<{ templateId: string; payloads: string[] } | null> {
  const version = await db.flowVersion.findFirst({
    where: { id: versionId },
    select: { id: true, graph: true, entryTemplateId: true },
  });

  if (!version) return null;

  const graph = readGraph(version.graph);
  if (!graph) return null;

  const entry = graph.nodes.find((n) => n.id === graph.entryNodeId);
  if (!entry || entry.kind !== "entry") return null;

  /*
   * One payload per button, all naming the same entry node. Which button the
   * customer pressed is read from the reply's text when it arrives - the
   * template's buttons carry their own labels, and Meta echoes the label back.
   */
  return {
    templateId: version.entryTemplateId,
    payloads: entry.choices.map(() =>
      encodeEntryButtonId({ versionId: version.id, nodeId: entry.id }),
    ),
  };
}
