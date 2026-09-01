import { describe, expect, it, vi } from "vitest";

import { VERSE_EMBEDDING, VERSE_MODELS } from "../src/verse/models.ts";
import {
  anthropicRouter,
  googleRouter,
  openaiEmbeddingRouter,
  openaiRouter,
  type ModelRouter,
  type VerseRequest,
} from "../src/verse/router.ts";

/**
 * The three adapters, against a fetch that never leaves the process.
 *
 * These exist because the interesting behaviour of a model adapter is entirely
 * in its failure paths, and none of those can be provoked with a real key. A
 * provider refusing on safety grounds, returning an empty completion, or
 * handing back embeddings out of order are all things that happen in
 * production and never in a happy-path smoke test.
 *
 * The order case is the one worth reading. It is the only fault here that
 * produces no error at all - every vector lands on the wrong chunk, every
 * similarity score stays plausible, and retrieval quietly returns the passage
 * NEXT TO the right one for ever.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQUEST: VerseRequest = {
  system: "You answer from the passages only.",
  turns: [{ role: "customer", text: "Do you deliver to Pune?" }],
  maxOutputTokens: 512,
};

describe("the Anthropic adapter (V1)", () => {
  it("returns the text and the provider's own token counts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ type: "text", text: "Yes, we deliver to Pune." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 812, output_tokens: 9 },
      }),
    );

    const outcome = await anthropicRouter(fetchImpl, "k").complete(REQUEST);

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") throw new Error("unreachable");
    expect(outcome.text).toBe("Yes, we deliver to Pune.");
    /* The provider's numbers, never our estimate. This is the billing figure. */
    expect(outcome.usage).toEqual({ inputTokens: 812, outputTokens: 9 });
  });

  it("sends the pinned model id and the system prompt", async () => {
    /*
     * Typed to fetch's real signature, not `async () => ...`.
     *
     * A zero-argument implementation types `mock.calls[0]` as the empty tuple,
     * so indexing it runs perfectly and fails `tsc`. The conventions skill
     * records this one; it is the reason every mock whose calls are inspected
     * below names its parameters.
     */
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );

    await anthropicRouter(fetchImpl, "secret-key").complete(REQUEST);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("api.anthropic.com");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe(VERSE_MODELS.V1.model);
    expect(body.system).toBe(REQUEST.system);
    expect(body.messages).toEqual([
      { role: "user", content: "Do you deliver to Pune?" },
    ]);
    /* No tool surface reaches the provider. See the header of router.ts. */
    expect(body.tools).toBeUndefined();
  });

  it("reads a safety refusal as refused, not as an outage", async () => {
    /*
     * The distinction is what stops a retry. A refusal retried is the same
     * refusal and a second charge, so this outcome escalates to a person.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [], stop_reason: "refusal" }),
    );

    const outcome = await anthropicRouter(fetchImpl, "k").complete(REQUEST);
    expect(outcome.kind).toBe("refused");
  });
});

describe("the Google adapter (V2)", () => {
  it("maps assistant turns to Google's `model` role", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Yes." }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      }),
    );

    await googleRouter(fetchImpl, "k").complete({
      ...REQUEST,
      turns: [
        { role: "customer", text: "hi" },
        { role: "assistant", text: "hello" },
        { role: "customer", text: "do you deliver?" },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String(init!.body));
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("reads a blocked prompt as refused", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }),
    );

    const outcome = await googleRouter(fetchImpl, "k").complete(REQUEST);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("SAFETY");
  });
});

describe("the OpenAI adapter (V3)", () => {
  it("reads a structured refusal as refused", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: null, refusal: "I can't help." } }],
      }),
    );

    const outcome = await openaiRouter(fetchImpl, "k").complete(REQUEST);
    expect(outcome.kind).toBe("refused");
  });
});

/* ------------------------------------------------------------------------- *
 * What every adapter must agree about
 * ------------------------------------------------------------------------- */

/**
 * A short timeout, passed explicitly.
 *
 * The adapters default to 30s, which is right in production and longer than
 * any sensible test timeout - so the abort case has to name its own. Passing
 * it here rather than shortening the default keeps the production value
 * honest: a timeout tuned to make a test fast is one that aborts real
 * generations.
 */
const TEST_TIMEOUT_MS = 50;

const ADAPTERS: Array<[string, (f: typeof fetch) => ModelRouter]> = [
  ["V1", (f) => anthropicRouter(f, "k", TEST_TIMEOUT_MS)],
  ["V2", (f) => googleRouter(f, "k", TEST_TIMEOUT_MS)],
  ["V3", (f) => openaiRouter(f, "k", TEST_TIMEOUT_MS)],
];

describe.each(ADAPTERS)("every adapter (%s)", (_tier, build) => {
  it("treats empty output as refused rather than as an empty answer", async () => {
    /*
     * An empty string would be sent as a WhatsApp bubble containing nothing:
     * to the customer it reads as the business replying with silence, and to
     * the operator it reads as a message that was delivered.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ type: "text", text: "   " }],
        candidates: [{ content: { parts: [{ text: "  " }] } }],
        choices: [{ message: { content: "\n\n" } }],
      }),
    );

    const outcome = await build(fetchImpl).complete(REQUEST);
    expect(outcome.kind).toBe("refused");
  });

  it("reads an HTTP failure as unavailable, and keeps the status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 503));

    const outcome = await build(fetchImpl).complete(REQUEST);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("503");
  });

  it("reads an unparseable body as unavailable rather than throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
    );

    const outcome = await build(fetchImpl).complete(REQUEST);
    expect(outcome.kind).toBe("unavailable");
  });

  it("aborts rather than hanging, and reports the timeout", async () => {
    /*
     * A raced timeout would leave the socket open. On an ingestion that is
     * thousands of abandoned requests the provider is still billing for.
     */
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    const outcome = await build(fetchImpl as unknown as typeof fetch).complete(
      REQUEST,
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("timed out");
  }, 10_000);
});

/* ------------------------------------------------------------------------- *
 * Embeddings
 * ------------------------------------------------------------------------- */

const DIMS = VERSE_EMBEDDING.dimensions;
const vector = (fill: number) => new Array(DIMS).fill(fill);

describe("the embedding adapter", () => {
  it("makes no call for an empty batch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const result = await openaiEmbeddingRouter(fetchImpl, "k").embed([]);

    expect(result).toEqual({ kind: "embedded", vectors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reorders by the provider's index rather than trusting arrival order", async () => {
    /*
     * ---------------------------------------------------------------------
     * The fault with no symptom
     * ---------------------------------------------------------------------
     *
     * The API documents that `data` may arrive out of order. Reading it
     * positionally attaches each chunk's vector to a neighbouring chunk.
     * Nothing errors. Every score stays in range, every result sorts, and the
     * index returns the passage next to the right one - for ever.
     *
     * The response below is deliberately shuffled: index 2 first, then 0,
     * then 1.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 2, embedding: vector(0.3) },
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: vector(0.2) },
        ],
      }),
    );

    const result = await openaiEmbeddingRouter(fetchImpl, "k").embed([
      "first",
      "second",
      "third",
    ]);

    expect(result.kind).toBe("embedded");
    if (result.kind !== "embedded") throw new Error("unreachable");
    expect(result.vectors[0]![0]).toBeCloseTo(0.1);
    expect(result.vectors[1]![0]).toBeCloseTo(0.2);
    expect(result.vectors[2]![0]).toBeCloseTo(0.3);
  });

  it("refuses a batch whose size does not match the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: vector(0.1) }] }),
    );

    const result = await openaiEmbeddingRouter(fetchImpl, "k").embed(["a", "b"]);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("got 1");
  });

  it("refuses a duplicate index rather than letting the last write win", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 0, embedding: vector(0.9) },
        ],
      }),
    );

    const result = await openaiEmbeddingRouter(fetchImpl, "k").embed(["a", "b"]);
    expect(result.kind).toBe("failed");
  });

  it("refuses a vector of the wrong width, naming both numbers", async () => {
    /*
     * The pin, checked where the failure can still name the model. Against the
     * vector(N) column this would surface as a Postgres type error three
     * layers down, and if that column were ever widened it would not surface
     * at all.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: new Array(768).fill(0.1) }] }),
    );

    const result = await openaiEmbeddingRouter(fetchImpl, "k").embed(["a"]);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("768");
    expect(result.reason).toContain(String(DIMS));
  });

  it("asks the provider for the pinned model and width", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ data: [{ index: 0, embedding: vector(0.1) }] }),
    );

    await openaiEmbeddingRouter(fetchImpl, "k").embed(["a"]);

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe(VERSE_EMBEDDING.model);
    expect(body.dimensions).toBe(DIMS);
  });
});
