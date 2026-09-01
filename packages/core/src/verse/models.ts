/**
 * Which model answers, and the one place a model string is written.
 *
 * ---------------------------------------------------------------------------
 * Why the keys are platform-level and not in the tenant vault
 * ---------------------------------------------------------------------------
 *
 * Every other credential in this system belongs to the tenant: their WhatsApp
 * app secret, their Google refresh token, and - since A3 - their own Meta ad
 * account. Those are in `integration_secrets`, sealed per company, because they
 * name an account the tenant holds and we merely borrow.
 *
 * These three do not. No tenant has an Anthropic or an OpenAI account, and the
 * product is deliberately built so they never learn which model answered: the
 * tenant buys "Verse", picks V1, V2 or V3, and what sits behind those letters
 * is ours to change. Putting the keys in the vault would create a per-tenant
 * field nobody can fill in, and a support path for a credential the tenant does
 * not have.
 *
 * The cost of that decision is that spend is OURS until it is attributed, which
 * is why every call writes a usage_events row against the company that caused
 * it. That is the only thing making a platform-level key safe to expose to
 * per-tenant traffic.
 *
 * ---------------------------------------------------------------------------
 * The tier is the tenant's vocabulary; the model string is ours
 * ---------------------------------------------------------------------------
 *
 * V1/V2/V3 are what a campaign stores and what the UI shows. The model string
 * appears exactly once, in MODEL_IDS below, and nothing else in the codebase
 * may write one - packages/core/tests/verse-models.test.ts greps for the
 * literals and fails if a second copy appears.
 *
 * That matters more here than it does for a Graph version. A model string
 * scattered across an adapter, a test fixture, a prompt-builder default and a
 * migration comment is one that gets half-updated, and the half that is missed
 * keeps billing at the old model's rate while the dashboard reports the new
 * one's name.
 */

/** What a tenant picks. Stored on a campaign; never a model string. */
export const VERSE_TIERS = ["V1", "V2", "V3"] as const;
export type VerseTier = (typeof VERSE_TIERS)[number];

export type VerseProvider = "anthropic" | "google" | "openai";

/**
 * THE model strings. One literal each, and nowhere else in the repository.
 *
 * Written without date suffixes deliberately: these ids are complete as they
 * stand, and appending a snapshot date produces a 404 at the provider rather
 * than a validation error here.
 */
const MODEL_IDS = {
  V1: "claude-sonnet-4-6",
  V2: "gemini-3.6-flash",
  V3: "gpt-5.6-terra",
} as const satisfies Record<VerseTier, string>;

export interface VerseModel {
  tier: VerseTier;
  provider: VerseProvider;
  /** The provider's own identifier. The only place one is written. */
  model: string;
  /** Which env var carries the key. Named so a failure can name it. */
  keyVar: string;
  /** What the tenant sees. Never the model string, never the provider. */
  label: string;
}

export const VERSE_MODELS: Readonly<Record<VerseTier, VerseModel>> = {
  V1: {
    tier: "V1",
    provider: "anthropic",
    model: MODEL_IDS.V1,
    keyVar: "VERSE_V1_API_KEY",
    label: "Verse V1",
  },
  V2: {
    tier: "V2",
    provider: "google",
    model: MODEL_IDS.V2,
    keyVar: "VERSE_V2_API_KEY",
    label: "Verse V2",
  },
  V3: {
    tier: "V3",
    provider: "openai",
    model: MODEL_IDS.V3,
    keyVar: "VERSE_V3_API_KEY",
    label: "Verse V3",
  },
};

/**
 * The cheapest tier, and the ONLY thing lead scoring may run on.
 *
 * Scoring is a classification over one short message and it runs on every
 * inbound message of every campaign - which makes it, by volume, the most
 * expensive thing in this phase if it follows the tenant's choice. A tenant
 * picking V1 for its answers is picking it for the answers; nothing about that
 * choice says they want a frontier model deciding HOT/WARM/COLD.
 *
 * Deliberately not a function of the campaign's tier. A "use the cheaper of
 * the two" rule reads as a courtesy and becomes wrong the moment the tiers are
 * repriced; naming the tier means a reprice moves one constant.
 */
export const VERSE_SCORING_TIER: VerseTier = "V2";

/* ------------------------------------------------------------------------- *
 * The embedding pin
 * ------------------------------------------------------------------------- */

/**
 * The embedding model, its dimensions, and the version that ties them to a
 * migration.
 *
 * ---------------------------------------------------------------------------
 * Changing this is a migration, never a config edit, and that is enforced
 * ---------------------------------------------------------------------------
 *
 * Two vectors are only comparable if they came from the same model. Cosine
 * similarity between an embedding from model A and one from model B is not a
 * worse number - it is a meaningless one, and it is meaningless in the most
 * dangerous available way: it still returns a float, still sorts, still clears
 * a floor, and still hands the generator a chunk that has nothing to do with
 * the question. Nothing throws. Retrieval quality simply collapses, and the
 * first symptom is a confident answer citing the wrong paragraph.
 *
 * So the model is pinned per index, and the pin has three parts that must all
 * agree:
 *
 *   1. EMBEDDING.model        here
 *   2. kb_chunks.embedding    vector(N) - N is fixed in the migration DDL
 *   3. knowledge_bases.embedding_model / _version - stamped per index
 *
 * `packages/db/tests/verse-embedding-pin.test.ts` asserts (1) and (2) agree by
 * reading the column's dimension out of the catalog. So editing this constant
 * alone FAILS THE SUITE, and the only way to make it pass is to write a
 * migration that re-embeds - which is exactly the deliberate, versioned act
 * this comment exists to force. There is no path where somebody changes the
 * model in a config file and the system quietly keeps serving.
 *
 * The version is separate from the model name because re-embedding under the
 * SAME model - a provider silently reissuing weights, which has happened - is
 * also a re-embedding. Bumping the version invalidates every stored vector
 * without pretending the model changed.
 */
export const VERSE_EMBEDDING = {
  provider: "openai" as VerseProvider,
  model: "text-embedding-3-small",
  /** Must equal the vector(N) in the kb_chunks migration. Asserted. */
  dimensions: 1536,
  /** Bump to invalidate every stored vector under an unchanged model name. */
  version: 1,
  keyVar: "VERSE_EMBEDDING_API_KEY",
} as const;

export function verseModel(tier: VerseTier): VerseModel {
  return VERSE_MODELS[tier];
}

/** Every env var this phase needs, so a failure can name what is missing. */
export const VERSE_KEY_VARS: readonly string[] = [
  VERSE_MODELS.V1.keyVar,
  VERSE_MODELS.V2.keyVar,
  VERSE_MODELS.V3.keyVar,
  VERSE_EMBEDDING.keyVar,
];
