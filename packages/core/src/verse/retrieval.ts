import { FLOOR } from "./floor.ts";
/**
 * The floor, and the refusal it exists to produce.
 *
 * ---------------------------------------------------------------------------
 * This is the whole product
 * ---------------------------------------------------------------------------
 *
 * A retrieval system that falls back on the model's general knowledge when its
 * index comes up empty is not a worse version of this one. It is a different
 * and far more dangerous thing, because the failure is invisible: a fluent,
 * confident, well-formatted answer about this business's refund policy,
 * invented, in the business's own voice, sent to their customer over their own
 * WhatsApp number.
 *
 * Nothing about that output looks wrong. It is not a hallucination the reader
 * can spot - it is a plausible policy, and the customer has no way to know the
 * business never had it. The business finds out when somebody holds them to it.
 *
 * So: if nothing clears the floor, Verse says it does not know and asks for a
 * person. That refusal is the feature. Everything else here is in service of
 * making it happen reliably rather than usually.
 *
 * ---------------------------------------------------------------------------
 * Why the decision is here and not in the SQL
 * ---------------------------------------------------------------------------
 *
 * The query could apply the floor in a WHERE clause and return nothing. It
 * deliberately does not, for two reasons.
 *
 * A caller that gets an empty list cannot tell "the index has nothing like
 * this" from "the index is empty" from "the query was wrong" - and those want
 * different handling and different operator-facing copy. Returning the best
 * score that did NOT clear makes the /dev/rag harness able to show why a
 * question was refused, which is the only way to tune the floor at all.
 *
 * And the decision is pure, so it is testable without a database, a model, or
 * a credential - which matters because it is the assertion this phase would
 * most like to get wrong.
 */

/**
 * Cosine similarity below which a passage is not evidence.
 *
 * Read from `floor.ts`, which carries the provenance with it - whether anybody
 * has actually measured this against real embeddings, when, against which
 * model, and against which question set. `/dev/rag` renders that status, so a
 * floor nobody has checked says so where somebody is looking at retrieval
 * results rather than only in a commit message.
 *
 * ---------------------------------------------------------------------------
 * This number is a STARTING POINT and is not yet earned
 * ---------------------------------------------------------------------------
 *
 * With text-embedding-3-small, unrelated English prose sits around 0.0-0.15,
 * loosely related text around 0.2-0.3, and a passage that actually answers a
 * question is usually above 0.4. 0.35 sits above the loose band and below the
 * answering band.
 *
 * That is a reasonable prior and NOT a measurement. The only thing that can set
 * this number honestly is the acceptance metric - 20 questions the knowledge
 * base answers and 5 it does not - because the floor's whole job is to separate
 * exactly those two populations, and where it belongs depends on the
 * embeddings, the chunk size and the kind of documents a tenant uploads.
 *
 * Raising it costs answers the system could have given. Lowering it costs the
 * only guarantee this phase makes. Neither is a knob to turn because a demo
 * looked disappointing, which is precisely what will be tempting the first time
 * somebody watches Verse refuse a question they know the answer to.
 *
 * `npm run verse:metric` is what earns it. Until that has run against real
 * embeddings this value is provisional, and the plan doc says so.
 */
export const SIMILARITY_FLOOR = FLOOR.value;

/**
 * How many passages reach the model.
 *
 * Six is a compromise between recall and dilution. More passages raise the
 * chance the answer is in there; they also lengthen the prompt, and every
 * irrelevant passage is one the model can be drawn toward - the failure being
 * an answer that is technically grounded in a passage nobody asked about.
 */
export const RETRIEVAL_TOP_K = 6;

/** One place a passage appears: a document, and where in it. */
export interface ChunkSource {
  documentId: string;
  documentTitle: string;
  /** Position within THIS document. The same passage sits elsewhere in others. */
  seq: number;
}

export interface RetrievedChunk {
  chunkId: string;
  /**
   * Every document this passage appears in, never just one.
   *
   * Chunks are deduplicated by content within a knowledge base, so identical
   * text is one passage that several documents point at. All of them are cited:
   * an answer that names only "Terms" when the sentence is also in the FAQ has
   * not lied, but it has told the operator less than we knew - and which single
   * document it would have named was decided by a tie.
   *
   * Never empty in practice. A chunk whose last source is deleted is deleted
   * with it, in the same transaction, because a passage nothing can attribute
   * is one that answers customers out of a document the tenant removed.
   */
  sources: readonly ChunkSource[];
  content: string;
  /** Cosine similarity in [-1, 1]. Higher is closer. Never a distance. */
  similarity: number;
}

export type Grounding =
  /** At least one passage cleared the floor. These are the evidence. */
  | { kind: "grounded"; chunks: readonly RetrievedChunk[] }
  /**
   * Nothing cleared the floor.
   *
   * `best` is the highest score seen, or null when the index returned nothing
   * at all. The two are different facts and the harness shows both: a best of
   * 0.34 means the floor may be a shade high, and a null means this knowledge
   * base has nothing on the subject - or nothing indexed yet.
   */
  | { kind: "ungrounded"; best: number | null };

/**
 * Decide whether these passages are evidence.
 *
 * Total, pure, and deliberately dull. The only interesting property is that
 * there is no branch anywhere that returns `grounded` with an empty list, and
 * no caller may treat `ungrounded` as "answer anyway" - the type is what makes
 * the second impossible to do by accident.
 */
export function groundingFor(
  chunks: readonly RetrievedChunk[],
  floor: number = SIMILARITY_FLOOR,
): Grounding {
  const cleared = chunks.filter((chunk) => chunk.similarity >= floor);

  if (cleared.length === 0) {
    const best = chunks.reduce<number | null>(
      (highest, chunk) =>
        highest === null || chunk.similarity > highest ? chunk.similarity : highest,
      null,
    );
    return { kind: "ungrounded", best };
  }

  /*
   * Ordered by score, best first, because the model reads a prompt top to
   * bottom and the ordering is the only signal it gets about which passage we
   * think is most likely to answer the question.
   */
  return {
    kind: "grounded",
    chunks: [...cleared].sort((a, b) => b.similarity - a.similarity),
  };
}

/**
 * pgvector returns cosine DISTANCE. Everything above is a similarity.
 *
 * `<=>` gives 0 for identical and 2 for opposite, so similarity is 1 - d. This
 * exists as a named function rather than as an inline `1 - row.distance`
 * because getting it backwards is silent: the floor would then keep exactly the
 * passages it was meant to reject, and retrieval would confidently return the
 * least relevant chunk in the base. There is a test for the direction.
 */
export function similarityFromCosineDistance(distance: number): number {
  return 1 - distance;
}
