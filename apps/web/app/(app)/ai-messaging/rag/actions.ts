"use server";

import {
  SIMILARITY_FLOOR,
  VERSE_MODELS,
  anthropicRouter,
  buildSystemPrompt,
  escalationBefore,
  googleRouter,
  groundingFor,
  openaiEmbeddingRouter,
  openaiRouter,
  type VerseTier,
} from "@whatsapp-os/core/verse";
import { retrieveChunks, withCompany } from "@whatsapp-os/db";
import { env } from "@/lib/env";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";

/**
 * One probe: retrieve, decide, and (only if grounded) generate.
 *
 * ---------------------------------------------------------------------------
 * It runs the SAME decisions as the reply path, in the same order
 * ---------------------------------------------------------------------------
 *
 * A harness that retrieves differently from production is a harness that tunes
 * the wrong number. So this calls groundingFor and escalationBefore exactly as
 * verse-reply does, and reports the verdict rather than deciding its own - the
 * point of looking at it is to see what a customer would have got.
 *
 * What it deliberately does NOT do is send anything, claim the driver, or
 * write usage. It is a read.
 */

export interface RagResult {
  error?: string;
  question?: string;
  /** Every chunk considered, including the ones that did not clear. */
  chunks?: Array<{
    /* Every document the passage appears in. The harness shows all of them,
       because a passage shared by four documents is a fact about the base an
       operator tuning the floor needs to see. */
    documentTitles: string[];
    content: string;
    similarity: number;
    cleared: boolean;
  }>;
  grounded?: boolean;
  /** Present when the probe would have handed over instead of answering. */
  escalation?: string;
  answer?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Milliseconds spent embedding the question, separately from generating. */
  embedMs?: number;
}

function routerFor(tier: VerseTier) {
  const model = VERSE_MODELS[tier];
  const key =
    tier === "V1"
      ? env.VERSE_V1_API_KEY
      : tier === "V2"
        ? env.VERSE_V2_API_KEY
        : env.VERSE_V3_API_KEY;

  if (!key) return null;

  switch (model.provider) {
    case "anthropic":
      return anthropicRouter(fetch, key);
    case "google":
      return googleRouter(fetch, key);
    case "openai":
      return openaiRouter(fetch, key);
  }
}

export async function probeAction(
  _state: RagResult,
  formData: FormData,
): Promise<RagResult> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const question = String(formData.get("question") ?? "").trim();
  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "");
  const tier = String(formData.get("modelTier") ?? "V1") as VerseTier;

  if (question.length === 0) return { error: "Ask something." };

  const embeddingKey = env.VERSE_EMBEDDING_API_KEY;
  if (!embeddingKey) {
    return {
      error:
        "VERSE_EMBEDDING_API_KEY is not set on this server, so nothing can be " +
        "embedded and retrieval cannot run.",
    };
  }

  const embedStarted = Date.now();
  const embedded = await openaiEmbeddingRouter(fetch, embeddingKey).embed([
    question,
  ]);
  const embedMs = Date.now() - embedStarted;

  if (embedded.kind === "failed") {
    return { error: `Embedding failed: ${embedded.reason}`, question };
  }

  const chunks = await withCompany(session.companyId, (db, companyId) =>
    retrieveChunks(db, companyId, {
      knowledgeBaseId,
      embedding: embedded.vectors[0]!,
    }),
  );

  const grounding = groundingFor(chunks, SIMILARITY_FLOOR);

  /*
   * Every chunk is shown, cleared or not.
   *
   * The ones BELOW the floor are the useful half: a question refused with a
   * best score of 0.34 says the floor may be a shade high, and one refused at
   * 0.02 says the base has nothing on the subject. Showing only what cleared
   * would make those two look identical, which is the exact thing that makes a
   * floor untunable.
   */
  const rendered = chunks.map((chunk) => ({
    documentTitles: chunk.sources.map((source) => source.documentTitle),
    content: chunk.content,
    similarity: chunk.similarity,
    cleared: chunk.similarity >= SIMILARITY_FLOOR,
  }));

  const escalation = escalationBefore({
    message: question,
    grounded: grounding.kind === "grounded",
    turnsWithoutProgress: 0,
  });

  if (escalation || grounding.kind !== "grounded") {
    return {
      question,
      chunks: rendered,
      grounded: grounding.kind === "grounded",
      escalation: escalation ?? "no_grounding",
      embedMs,
    };
  }

  const router = routerFor(tier);
  if (!router) {
    return {
      question,
      chunks: rendered,
      grounded: true,
      error: `No credential for ${VERSE_MODELS[tier].label} on this server.`,
      embedMs,
    };
  }

  const outcome = await router.complete({
    system: buildSystemPrompt({
      goal: "Answer questions about this business from the passages provided.",
      businessName: "this business",
      chunks: grounding.chunks,
    }),
    turns: [{ role: "customer", text: question }],
    maxOutputTokens: 512,
  });

  if (outcome.kind !== "answered") {
    return {
      question,
      chunks: rendered,
      grounded: true,
      escalation: outcome.kind,
      embedMs,
      latencyMs: outcome.latencyMs,
    };
  }

  return {
    question,
    chunks: rendered,
    grounded: true,
    answer: outcome.text,
    embedMs,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
  };
}
