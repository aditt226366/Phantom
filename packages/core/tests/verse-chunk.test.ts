import { describe, expect, it } from "vitest";

import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  chunkText,
  estimateTokens,
} from "../src/verse/chunk.ts";

/**
 * Chunking, and the one property that is not about size.
 *
 * The size assertions are bracketing - a ceiling asserted from both sides, per
 * the rule the flow builder's MAX_STEPS ceiling produced: "the loop stops" is
 * satisfied by any finite constant and proves nothing.
 *
 * The property that matters is the overlap, and it matters for a specific
 * failure. A policy split exactly at a chunk boundary - "refunds are
 * available" | "within 14 days of delivery" - produces a first chunk that
 * answers the question WRONGLY and with complete confidence. The overlap is
 * what guarantees every span appears whole somewhere.
 */

/**
 * Roughly n tokens of prose, in sentences so the splitter has boundaries.
 *
 * Every call produces DIFFERENT text, and that is load-bearing rather than
 * tidy. The first version repeated one sentence, which made two assertions
 * here pass for the wrong reason: "the previous chunk contains this chunk's
 * head" is trivially true when every paragraph is the same string, and the
 * overlap-only check found a suffix match that was a coincidence of repetition
 * rather than a carried overlap. A fixture that repeats itself cannot tell a
 * splitter that carries context from one that does not.
 */
let proseCounter = 0;
function prose(tokens: number, word = "delivery"): string {
  const chars = tokens * 4;
  const tag = (proseCounter += 1);
  let out = "";
  let i = 0;
  while (out.length < chars) {
    out += `${word} ${tag}-${i} is a distinct sentence about the policy. `;
    i += 1;
  }
  return out.slice(0, chars);
}

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \t ")).toEqual([]);
  });

  it("keeps a short document as one chunk", () => {
    const chunks = chunkText("We deliver to Pune in 3-5 working days.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("We deliver to Pune in 3-5 working days.");
    expect(chunks[0]!.seq).toBe(0);
  });

  it("numbers chunks from zero, without gaps", () => {
    const chunks = chunkText(
      Array.from({ length: 8 }, () => prose(400)).join("\n\n"),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.seq)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  /* ----------------------------------------------------------------------- *
   * The ceiling, asserted from both sides
   * ----------------------------------------------------------------------- */

  it("does not split a document that fits inside the target", () => {
    /*
     * The lower bracket. Without it, "no chunk exceeds the target" is
     * satisfied by a function that returns one chunk per sentence.
     */
    const chunks = chunkText(prose(CHUNK_TARGET_TOKENS - 200));
    expect(chunks).toHaveLength(1);
  });

  it("splits a document that exceeds the target", () => {
    const chunks = chunkText(
      [prose(CHUNK_TARGET_TOKENS), prose(CHUNK_TARGET_TOKENS)].join("\n\n"),
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps every chunk near the target, allowing for the carried overlap", () => {
    const chunks = chunkText(
      Array.from({ length: 12 }, () => prose(300)).join("\n\n"),
    );

    for (const chunk of chunks) {
      /*
       * The overlap is prepended before the next piece is measured, so a chunk
       * may exceed the target by up to one piece. What must not happen is a
       * chunk several times the target, which is what an absent split looks
       * like.
       */
      expect(chunk.tokenCount).toBeLessThan(CHUNK_TARGET_TOKENS * 2);
    }
  });

  /* ----------------------------------------------------------------------- *
   * The overlap - the assertion this file exists for
   * ----------------------------------------------------------------------- */

  it("carries the tail of each chunk into the next", () => {
    const chunks = chunkText(
      Array.from({ length: 10 }, (_, i) => prose(300, `topic${i}`)).join("\n\n"),
    );

    expect(chunks.length).toBeGreaterThan(2);

    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!.content;
      const current = chunks[i]!.content;
      /*
       * The first characters of a chunk must appear at the end of its
       * predecessor. Asserted as a real substring rather than as "the chunks
       * are longer than the document / N", which would pass for a splitter
       * that merely repeated arbitrary text.
       */
      const head = current.slice(0, 40);
      expect(previous).toContain(head);
    }
  });

  it("keeps a sentence split across a boundary whole in one chunk", () => {
    /*
     * The failure in its concrete form. Without overlap this sentence lands
     * split, and the chunk ending "...refunds are available" is a confident
     * wrong answer to "can I get a refund".
     */
    const sentence =
      "Refunds are available within 14 days of delivery and not after.";
    const document = [prose(700), sentence, prose(700)].join("\n\n");

    const chunks = chunkText(document);
    expect(chunks.some((c) => c.content.includes(sentence))).toBe(true);
  });

  it("does not emit a final chunk that is only the carried overlap", () => {
    /*
     * A chunk that duplicates text already indexed costs an embedding and then
     * competes with its own original at retrieval time.
     */
    const chunks = chunkText(
      Array.from({ length: 5 }, () => prose(CHUNK_TARGET_TOKENS / 2)).join(
        "\n\n",
      ),
    );

    const last = chunks[chunks.length - 1]!;
    const previous = chunks[chunks.length - 2];
    if (previous) {
      expect(previous.content.endsWith(last.content)).toBe(false);
    }
  });

  /* ----------------------------------------------------------------------- *
   * Shapes that are not prose
   * ----------------------------------------------------------------------- */

  it("splits a single paragraph that is longer than the target", () => {
    const chunks = chunkText(prose(CHUNK_TARGET_TOKENS * 3));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("splits a single unbroken run with no sentence boundaries at all", () => {
    /*
     * A minified file or a table with no punctuation. Cutting it badly beats
     * emitting one enormous chunk whose embedding matches nothing.
     */
    const blob = "x".repeat(CHUNK_TARGET_TOKENS * 4 * 3);
    const chunks = chunkText(blob);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThan(CHUNK_TARGET_TOKENS * 2);
    }
  });

  it("collapses PDF whitespace without losing paragraph structure", () => {
    /*
     * Hard wrapping, non-breaking spaces and a form feed are what a text layer
     * actually arrives as. None of it means anything and all of it changes the
     * embedding.
     */
    const extracted =
      "We deliver   to Pune.\r\nIt takes 3-5 days.\f\fRefunds within 14 days.";
    const chunks = chunkText(extracted);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).not.toContain("\r");
    expect(chunks[0]!.content).not.toContain(" ");
    expect(chunks[0]!.content).not.toMatch(/ {2,}/);
    /* The form feed was a paragraph break and survives as one. */
    expect(chunks[0]!.content).toContain("\n\n");
  });
});

describe("estimateTokens", () => {
  it("is monotonic in length", () => {
    expect(estimateTokens("abcd")).toBeLessThan(estimateTokens("abcdefgh"));
  });

  it("counts an empty string as nothing", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("the constants", () => {
  it("keeps the overlap well below the target", () => {
    /*
     * An overlap approaching the target makes every chunk mostly a copy of its
     * neighbour, which doubles the index and makes retrieval return the same
     * passage three times.
     */
    expect(CHUNK_OVERLAP_TOKENS).toBeLessThan(CHUNK_TARGET_TOKENS / 4);
    expect(CHUNK_OVERLAP_TOKENS).toBeGreaterThan(0);
  });
});
