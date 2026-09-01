import { beforeEach, describe, expect, it, vi } from "vitest";

import { VERSE_EMBEDDING, SIMILARITY_FLOOR } from "@whatsapp-os/core/verse";

/**
 * The reply job's shape, which is where its money and its safety live.
 *
 * What each piece computes is proved elsewhere - the floor in packages/core
 * with no database, retrieval against real pgvector in packages/db. What is
 * asserted here is the SEQUENCE, because three of its orderings are the whole
 * design and two of them cost real money when reversed:
 *
 *   the window is checked BEFORE any model call
 *   escalation is decided BEFORE any model call
 *   usage is recorded against OUR message id, once
 *
 * Each of the three is broken once against this file.
 */

const DIMS = VERSE_EMBEDDING.dimensions;
const vector = (fill: number) => new Array(DIMS).fill(fill);

interface Decision {
  allowed: boolean;
  reason?: string;
}

let sendability: { decision: Decision } | null = { decision: { allowed: true } };
let context: Record<string, unknown> | null = null;
let chunks: Array<Record<string, unknown>> = [];

const canSend = vi.fn(
  async (
    _db: unknown,
    _companyId: string,
    _conversationId: string,
    _intent: unknown,
    _now: Date,
  ) => sendability,
);

const verseContextFor = vi.fn(
  async (_db: unknown, _companyId: string, _conversationId: string) => context,
);

const retrieveChunks = vi.fn(
  async (_db: unknown, _companyId: string, _input: unknown) => chunks,
);

const flagNeedsHuman = vi.fn(
  async (
    _db: unknown,
    _companyId: string,
    _conversationId: string,
    _input: { reason: string; at: Date },
  ) => undefined,
);

const releaseDriver = vi.fn(
  async (_db: unknown, _companyId: string, _conversationId: string) => undefined,
);

const recordUsage = vi.fn(
  async (_db: unknown, _companyId: string, _input: { kind: string; dedupeKey: string }) => ({
    recorded: true,
    costMicros: null,
    currency: null,
    unpricedReason: null,
  }),
);

const materialiseFlowMessage = vi.fn(
  async (_db: unknown, _companyId: string, _input: unknown) => ({
    messageId: "msg-out",
    sendAttempt: 0,
  }),
);

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn({}, companyId),
  canSend,
  verseContextFor,
  retrieveChunks,
  flagNeedsHuman,
  releaseDriver,
  recordUsage,
  materialiseFlowMessage,
}));

const queueAdd = vi.fn(async () => ({}));
vi.mock("../src/queue.ts", () => ({ systemQueue: { add: queueAdd } }));

/* A configured server. The unconfigured case is its own test below. */
vi.mock("../src/env.ts", () => ({
  env: {
    VERSE_V1_API_KEY: "k1",
    VERSE_V2_API_KEY: "k2",
    VERSE_V3_API_KEY: "k3",
    VERSE_EMBEDDING_API_KEY: "ke",
  },
}));

const completions: Array<Record<string, unknown>> = [];
const embedCalls: string[][] = [];

/*
 * The routers are stubbed at the module boundary rather than through fetch, so
 * "was a model called at all" is directly observable. That is the assertion
 * two of the three orderings turn on.
 */
vi.mock("@whatsapp-os/core/verse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whatsapp-os/core/verse")>();
  const router = {
    tier: "V1" as const,
    complete: async (request: Record<string, unknown>) => {
      completions.push(request);
      return {
        kind: "answered" as const,
        text: "We deliver to Pune in 3-5 working days.",
        usage: { inputTokens: 800, outputTokens: 12 },
        latencyMs: 400,
      };
    },
  };
  return {
    ...actual,
    anthropicRouter: () => router,
    googleRouter: () => router,
    openaiRouter: () => router,
    openaiEmbeddingRouter: () => ({
      model: actual.VERSE_EMBEDDING.model,
      dimensions: actual.VERSE_EMBEDDING.dimensions,
      version: actual.VERSE_EMBEDDING.version,
      embed: async (texts: string[]) => {
        embedCalls.push(texts);
        return { kind: "embedded" as const, vectors: [vector(0.1)] };
      },
    }),
  };
});

const { handleVerseReply, countVerseTurnsSinceCustomerProgress } = await import(
  "../src/jobs/verse-reply.ts"
);

const JOB = {
  companyId: "co-1",
  conversationId: "conv-1",
  messageId: "msg-in",
};

function grounded(similarity = 0.8) {
  return [
    {
      chunkId: "c1",
      documentId: "d1",
      documentTitle: "Delivery",
      seq: 0,
      content: "We deliver across Maharashtra in 3-5 working days.",
      similarity,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  completions.length = 0;
  embedCalls.length = 0;
  sendability = { decision: { allowed: true } };
  chunks = grounded();
  context = {
    conversationId: "conv-1",
    contactId: "contact-1",
    campaignId: "camp-1",
    campaignName: "Winter",
    goal: "Answer delivery questions.",
    modelTier: "V1",
    knowledgeBaseId: "kb-1",
    businessName: "Kamat Textiles",
    templateId: "tpl-1",
    history: [{ inbound: true, body: "do you deliver to Pune" }],
  };
});

describe("the window is checked before the model", () => {
  it("answers when the window is open", async () => {
    await handleVerseReply(JOB);

    expect(completions).toHaveLength(1);
    expect(materialiseFlowMessage).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it("calls no model at all when the window has closed", async () => {
    /*
     * The assertion that costs money when it regresses. A reply generated for
     * a conversation that cannot receive it is a provider bill for text
     * nobody will ever read - and generating first reads more naturally, which
     * is exactly why this is asserted rather than trusted.
     */
    sendability = { decision: { allowed: false, reason: "window_closed" } };

    await handleVerseReply(JOB);

    expect(completions).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
    expect(materialiseFlowMessage).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("checks the window before embedding, not only before generating", async () => {
    /* Embedding is also a paid call. Checking between the two would halve the
       waste rather than remove it. */
    sendability = { decision: { allowed: false, reason: "company_not_verified" } };

    await handleVerseReply(JOB);

    expect(embedCalls).toHaveLength(0);
  });

  it("does not send a template to reopen a lapsed window", async () => {
    /*
     * The campaign's approved template is an OPENER. Firing it at somebody
     * mid-conversation because their window lapsed restarts the conversation
     * rather than continuing it, and re-opening is the campaign engine's job
     * on its own schedule and against its daily cap.
     */
    sendability = { decision: { allowed: false, reason: "window_closed" } };

    await handleVerseReply(JOB);

    expect(materialiseFlowMessage).not.toHaveBeenCalled();
  });
});

describe("escalation", () => {
  it("hands over without calling a model when nothing clears the floor", async () => {
    chunks = grounded(SIMILARITY_FLOOR - 0.05);

    await handleVerseReply(JOB);

    expect(completions).toHaveLength(0);
    expect(flagNeedsHuman).toHaveBeenCalledTimes(1);

    const [, , , input] = flagNeedsHuman.mock.calls[0]!;
    expect(input.reason).toContain("nothing in the knowledge base");
  });

  it("hands over a restricted subject without calling a model", async () => {
    /*
     * Decided before the model, so a refund question never reaches one.
     * Deciding afterwards would pay to generate an answer already resolved not
     * to send - and leave that answer in a log where somebody could use it.
     */
    context = { ...context!, history: [{ inbound: true, body: "I want a refund" }] };

    await handleVerseReply(JOB);

    expect(completions).toHaveLength(0);
    expect(flagNeedsHuman).toHaveBeenCalledTimes(1);
    expect(flagNeedsHuman.mock.calls[0]![3].reason).toContain("refund");
  });

  it("escalates even when the knowledge base covers the restricted subject", async () => {
    /* A base that happens to contain the refund policy must not let the model
       answer a refund request. */
    context = { ...context!, history: [{ inbound: true, body: "refund please" }] };
    chunks = grounded(0.95);

    await handleVerseReply(JOB);

    expect(completions).toHaveLength(0);
  });

  it("tells the customer, and releases the driver", async () => {
    chunks = grounded(0.01);

    await handleVerseReply(JOB);

    /* The customer gets a sentence - a handoff nobody sees is a person
       arriving into a conversation with no explanation of the gap. */
    expect(materialiseFlowMessage).toHaveBeenCalledTimes(1);
    expect(releaseDriver).toHaveBeenCalledTimes(1);
  });

  it("flags before it releases", async () => {
    /*
     * A crash between the two must leave a thread flagged for a person and
     * still showing Verse as its driver, which an operator can act on. The
     * reverse leaves a released thread with nobody told - a customer waiting
     * with no queue entry.
     */
    chunks = grounded(0.01);

    await handleVerseReply(JOB);

    expect(flagNeedsHuman.mock.invocationCallOrder[0]!).toBeLessThan(
      releaseDriver.mock.invocationCallOrder[0]!,
    );
  });

  it("hands over rather than stopping silently when no credential is set", async () => {
    /*
     * A customer has asked something and is waiting. Doing nothing leaves them
     * waiting for ever with nobody told.
     */
    vi.resetModules();
    vi.doMock("../src/env.ts", () => ({ env: {} }));
    const fresh = await import("../src/jobs/verse-reply.ts");

    await fresh.handleVerseReply(JOB);

    expect(flagNeedsHuman).toHaveBeenCalled();
    vi.doUnmock("../src/env.ts");
    vi.resetModules();
  });
});

describe("usage", () => {
  it("records one reply against our own message id", async () => {
    await handleVerseReply(JOB);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const [, , input] = recordUsage.mock.calls[0]!;

    expect(input.kind).toBe("verse.reply");
    /*
     * OUR message id, not the job id and not the wamid. The job retries and
     * the wamid does not exist until Meta answers, so either would charge
     * twice for one answer - and this table is an invoice.
     */
    expect(input.dedupeKey).toBe("verse.reply:msg-out");
  });

  it("records nothing when the model was never called", async () => {
    sendability = { decision: { allowed: false, reason: "window_closed" } };

    await handleVerseReply(JOB);

    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe("the driver is re-read at answer time", () => {
  it("does nothing when the conversation is no longer Verse's", async () => {
    /*
     * The claim at ENQUEUE time is worth nothing: an operator can take the
     * thread between the webhook landing and this job running, and answering
     * then would be a second writer in a conversation a person is having.
     */
    context = null;

    await handleVerseReply(JOB);

    expect(completions).toHaveLength(0);
    expect(materialiseFlowMessage).not.toHaveBeenCalled();
    expect(flagNeedsHuman).not.toHaveBeenCalled();
  });
});

describe("countVerseTurnsSinceCustomerProgress", () => {
  it("counts consecutive replies since the customer last wrote", () => {
    expect(
      countVerseTurnsSinceCustomerProgress([
        { inbound: true, body: "hi" },
        { inbound: false, body: "a" },
        { inbound: false, body: "b" },
      ]),
    ).toBe(2);
  });

  it("resets when the customer says something", () => {
    expect(
      countVerseTurnsSinceCustomerProgress([
        { inbound: false, body: "a" },
        { inbound: true, body: "ok but" },
      ]),
    ).toBe(0);
  });
});
