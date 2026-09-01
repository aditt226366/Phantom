import { describe, expect, it } from "vitest";

import {
  RETRIEVAL_TOP_K,
  SIMILARITY_FLOOR,
  groundingFor,
  similarityFromCosineDistance,
  type RetrievedChunk,
} from "../src/verse/retrieval.ts";

/**
 * The floor.
 *
 * ---------------------------------------------------------------------------
 * Why this file matters more than the rest of the phase
 * ---------------------------------------------------------------------------
 *
 * Everything else here can be wrong and produce a visible failure. This can be
 * wrong and produce a fluent, confident, correctly-formatted answer about the
 * tenant's refund policy that they never wrote, sent to their customer over
 * their own number, in their own voice.
 *
 * Nothing about that output looks like a bug. The customer cannot tell. The
 * business finds out when somebody holds them to it.
 *
 * So the assertions below are about one property: there is no input for which
 * this returns `grounded` without a passage that actually cleared the floor.
 */

function chunk(similarity: number, id = `c${similarity}`): RetrievedChunk {
  return {
    chunkId: id,
    documentId: "doc",
    documentTitle: "Refund policy",
    seq: 0,
    content: "Refunds are available within 14 days of delivery.",
    similarity,
  };
}

describe("groundingFor", () => {
  it("is ungrounded when the index returned nothing at all", () => {
    /*
     * `best: null` rather than 0. An empty base and a base full of irrelevant
     * passages are different facts with different remedies - upload something,
     * versus this question is genuinely not covered - and the harness shows
     * which.
     */
    expect(groundingFor([])).toEqual({ kind: "ungrounded", best: null });
  });

  it("is ungrounded when nothing clears the floor, and reports the best miss", () => {
    const grounding = groundingFor([chunk(0.1), chunk(0.31), chunk(0.2)]);

    expect(grounding.kind).toBe("ungrounded");
    if (grounding.kind !== "ungrounded") throw new Error("unreachable");
    /*
     * The near miss is the only thing that makes the floor tunable. A refusal
     * at 0.34 says something different from a refusal at 0.02, and without
     * this the operator sees the same "I don't know" for both.
     */
    expect(grounding.best).toBeCloseTo(0.31);
  });

  /* --------------------------------------------------------------------- *
   * The threshold, asserted from BOTH sides
   * --------------------------------------------------------------------- */

  it("refuses a passage just below the floor", () => {
    expect(groundingFor([chunk(SIMILARITY_FLOOR - 0.0001)]).kind).toBe(
      "ungrounded",
    );
  });

  it("accepts a passage exactly at the floor", () => {
    /*
     * Both sides, because a one-sided assertion passes for every value above
     * the real one - the lesson MAX_STEPS_PER_ADVANCE produced when
     * multiplying the constant by a million left the suite green. Without this
     * test a floor of 0.99 would pass the one above.
     */
    expect(groundingFor([chunk(SIMILARITY_FLOOR)]).kind).toBe("grounded");
  });

  it("keeps only the passages that cleared, never the ones that did not", () => {
    const grounding = groundingFor([
      chunk(0.9, "high"),
      chunk(0.1, "low"),
      chunk(0.5, "mid"),
    ]);

    expect(grounding.kind).toBe("grounded");
    if (grounding.kind !== "grounded") throw new Error("unreachable");
    expect(grounding.chunks.map((c) => c.chunkId)).toEqual(["high", "mid"]);
  });

  it("orders the evidence best first", () => {
    /*
     * The model reads top to bottom, and the ordering is the only signal it
     * gets about which passage we think most likely answers the question.
     */
    const grounding = groundingFor([chunk(0.5, "mid"), chunk(0.9, "high")]);

    if (grounding.kind !== "grounded") throw new Error("unreachable");
    expect(grounding.chunks.map((c) => c.chunkId)).toEqual(["high", "mid"]);
  });

  it("never returns grounded with an empty list", () => {
    /*
     * The invariant every caller depends on. Swept rather than spot-checked,
     * because a caller reading `grounding.chunks[0]!.content` on an empty
     * grounded result is how an empty REFERENCE PASSAGES block reaches a model
     * - and an empty passage block is exactly the state where it answers from
     * general knowledge.
     */
    for (let s = -1; s <= 1.0001; s += 0.01) {
      const grounding = groundingFor([chunk(Number(s.toFixed(4)))]);
      if (grounding.kind === "grounded") {
        expect(grounding.chunks.length).toBeGreaterThan(0);
      }
    }
  });

  it("takes the floor as an argument, so the harness can sweep it", () => {
    /* Tuning happens against the acceptance metric, not by editing a constant
       while watching one conversation. */
    expect(groundingFor([chunk(0.2)], 0.1).kind).toBe("grounded");
    expect(groundingFor([chunk(0.2)], 0.9).kind).toBe("ungrounded");
  });
});

describe("similarityFromCosineDistance", () => {
  it("maps identical to 1 and opposite to -1", () => {
    /*
     * The direction, which is silent when wrong. pgvector's `<=>` is a
     * DISTANCE: 0 is identical. Getting this backwards makes the floor keep
     * exactly the passages it exists to reject, and retrieval then returns the
     * least relevant chunk in the base with complete confidence.
     */
    expect(similarityFromCosineDistance(0)).toBe(1);
    expect(similarityFromCosineDistance(1)).toBe(0);
    expect(similarityFromCosineDistance(2)).toBe(-1);
  });

  it("is monotonically decreasing in distance", () => {
    expect(similarityFromCosineDistance(0.2)).toBeGreaterThan(
      similarityFromCosineDistance(0.8),
    );
  });
});

describe("the constants", () => {
  it("keeps the floor inside the range a cosine similarity can take", () => {
    expect(SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(SIMILARITY_FLOOR).toBeLessThan(1);
  });

  it("retrieves more than one passage and fewer than a promptful", () => {
    /*
     * Bracketed for the same reason the floor is. One passage is a system with
     * no recall; fifty is a prompt where the answer is diluted by forty-nine
     * irrelevant ones, and "grounded in a passage nobody asked about" is a
     * real failure mode.
     */
    expect(RETRIEVAL_TOP_K).toBeGreaterThan(1);
    expect(RETRIEVAL_TOP_K).toBeLessThanOrEqual(20);
  });
});
