/**
 * The similarity floor, and where it came from.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not a JSON file read at runtime
 * ---------------------------------------------------------------------------
 *
 * `denylist.ts` did `new URL("./data/…", import.meta.url)` and handed it to
 * readFileSync: correct Node, correct under Vitest, and broken under Turbopack,
 * which supplies its own URL class that fails Node's `instanceof` check. The
 * error reads "must be of type string or an instance of URL. Received an
 * instance of URL", which is a sentence that helps nobody.
 *
 * The fix there was to embed the data in a `.ts` module, and this follows it.
 * The file is still checked in, still readable in a diff, and still the single
 * place the value lives - it just cannot be resolved wrongly by a bundler.
 *
 * ---------------------------------------------------------------------------
 * Why the provenance travels with the number
 * ---------------------------------------------------------------------------
 *
 * A bare `export const SIMILARITY_FLOOR = 0.35` is a number with no way to ask
 * whether anybody ever checked it. This phase shipped with a floor that was
 * reasoned about and never measured, and the difference between those two
 * states is the difference between a working retrieval system and one that
 * confidently invents a price - so the state has to be readable at runtime,
 * not merely recorded in a commit message somebody would have to go and find.
 *
 * `/dev/rag` renders `status` directly. A missing measurement visible only in
 * `git status` is a missing measurement nobody sees.
 *
 * WRITTEN BY `npm run verse:metric`. Editing `value` by hand without changing
 * `status` back to "provisional" is the one thing this file exists to make
 * embarrassing.
 */

export interface FloorProvenance {
  /** Cosine similarity below which a passage is not evidence. */
  value: number;
  /**
   * Whether anybody has actually checked this against real embeddings.
   *
   * "provisional" means it was reasoned about from what the embedding model
   * typically produces. That is a prior, not a measurement, and the phase doc
   * says so at the top.
   */
  status: "provisional" | "measured";
  /** ISO date the value was set. */
  setAt: string;
  /** Which embedding model it was measured against. Meaningless across models. */
  embeddingModel: string;
  /** What it was measured against, or why it was not. */
  questionSet: string;
  /** Present only when measured: how the run scored. */
  result?: {
    groundedCorrect: number;
    groundedTotal: number;
    handedOff: number;
    handoffTotal: number;
  };
}

export const FLOOR: FloorProvenance = {
  value: 0.35,
  status: "provisional",
  setAt: "2026-09-08",
  embeddingModel: "text-embedding-3-small",
  questionSet:
    "NOT MEASURED. No provider credentials were available when this phase " +
    "shipped, so the 20/5 acceptance metric could not run. 0.35 is a prior " +
    "from where this embedding model typically places unrelated prose " +
    "(0.0-0.15), loosely related text (0.2-0.3) and passages that actually " +
    "answer a question (above 0.4). Run `npm run verse:metric` to replace it.",
};

/** True when nobody has checked this number against real embeddings. */
export function floorIsProvisional(): boolean {
  return FLOOR.status === "provisional";
}
