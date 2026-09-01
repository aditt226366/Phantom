/**
 * The client-safe half of the Verse AI layer.
 *
 * Everything here must be importable from a "use client" component - the
 * campaign wizard shows tier labels and validates a daily window as somebody
 * types, against the same module the worker enforces with.
 *
 * Nothing in this directory reaches for node:crypto, the database or the
 * filesystem, and nothing should start to. The core barrel dragged a native
 * Argon2 binding into the browser graph for six commits before a page rendered
 * and the build noticed, and `leads/hash.ts` repeated it one directory over.
 *
 * The router lives here rather than behind a `-server` subpath because it uses
 * nothing but `fetch` and `AbortController`, both of which are web standards.
 * What keeps it off the client is that it takes an API key as an argument and
 * no client code has one - a property of the call sites, which is weaker than a
 * bundler boundary, so `verse-keys.test.ts` asserts no key is read outside the
 * worker and the two server-side entry points.
 */
export {
  VERSE_EMBEDDING,
  VERSE_KEY_VARS,
  VERSE_MODELS,
  VERSE_SCORING_TIER,
  VERSE_TIERS,
  verseModel,
} from "./models.ts";
export type { VerseModel, VerseProvider, VerseTier } from "./models.ts";

export {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  chunkText,
  estimateTokens,
} from "./chunk.ts";
export type { Chunk } from "./chunk.ts";

export {
  VERSE_TIMEOUT_MS,
  anthropicRouter,
  googleRouter,
  openaiEmbeddingRouter,
  openaiRouter,
} from "./router.ts";
export type {
  EmbeddingRouter,
  ModelRouter,
  VerseOutcome,
  VerseRequest,
  VerseTurn,
  VerseUsage,
} from "./router.ts";

export {
  RETRIEVAL_TOP_K,
  SIMILARITY_FLOOR,
  groundingFor,
  similarityFromCosineDistance,
} from "./retrieval.ts";
export type { Grounding, RetrievedChunk } from "./retrieval.ts";

export {
  A5_HONESTY_RULE,
  A5_OFF_TOPIC_RULE,
  MAX_TURNS_WITHOUT_PROGRESS,
  buildSystemPrompt,
  escalationBefore,
  handoffMessage,
  handoffReason,
  isRestrictedSubject,
  turnsFrom,
} from "./prompt.ts";
export type { EscalationInput, EscalationReason, PromptInput } from "./prompt.ts";

export { FLOOR, floorIsProvisional } from "./floor.ts";
export type { FloorProvenance } from "./floor.ts";
