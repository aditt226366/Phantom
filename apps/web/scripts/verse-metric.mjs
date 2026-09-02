import "./_load-env.mjs";

/**
 * The acceptance metric: 20 questions the knowledge base answers, 5 it does not.
 *
 * ===========================================================================
 * THIS EXITS NON-ZERO WHEN IT CANNOT RUN
 * ===========================================================================
 *
 * It does not skip. It does not print a pass with a caveat. A metric that
 * reports "not run" inside a green run is one that stays not run for ever, and
 * this is the only check in the phase that measures the thing the phase is
 * actually about.
 *
 * Everything else proves the machinery is wired correctly - the floor rejects
 * what is below it, escalation fires, the window is checked. None of that
 * proves the floor is in the RIGHT PLACE, and that is the whole difference
 * between a working retrieval system and one that confidently invents a price.
 *
 * ===========================================================================
 * The bar
 * ===========================================================================
 *
 *   at least 17 of 20 answered correctly AND grounded
 *   5 of 5 handed off
 *
 * The second number has no tolerance. One ungrounded answer among the five
 * fails the phase, because a single invented policy is the failure this whole
 * layer exists to prevent - and a system that invents one in five is not
 * "83% good", it is a liability with a good day.
 *
 *   npm run verse:metric -- <companyId> <knowledgeBaseId>
 */

import { randomUUID } from "node:crypto";
import {
  SIMILARITY_FLOOR,
  VERSE_KEY_VARS,
  VERSE_MODELS,
  anthropicRouter,
  buildSystemPrompt,
  escalationBefore,
  googleRouter,
  groundingFor,
  openaiEmbeddingRouter,
  openaiRouter,
} from "@whatsapp-os/core/verse";
import { retrieveChunks, withCompany } from "@whatsapp-os/db";
import { QUESTIONS } from "./verse-questions.mjs";

/* ------------------------------------------------------------------------- *
 * The refusal, first
 * ------------------------------------------------------------------------- */

const missing = VERSE_KEY_VARS.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    [
      "",
      "THE VERSE ACCEPTANCE METRIC CANNOT RUN.",
      "",
      "It needs real embedding and real generation calls, and these are not set:",
      "",
      ...missing.map((name) => `    ${name}`),
      "",
      "This exits non-zero rather than skipping, deliberately. The 20/5 is the",
      "only check that measures whether the similarity floor is in the right",
      "place, and every other test in this phase passes without it - so a skip",
      "here would read as a green phase with its acceptance criterion never",
      "having been evaluated.",
      "",
      "Set them in .env and run again:",
      "",
      "    npm run verse:metric -- <companyId> <knowledgeBaseId>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const [companyId, knowledgeBaseId] = process.argv.slice(2);

if (!companyId || !knowledgeBaseId) {
  console.error(
    "\nUsage: npm run verse:metric -- <companyId> <knowledgeBaseId>\n",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * The run
 * ------------------------------------------------------------------------- */

const TIER = process.env.VERSE_METRIC_TIER ?? "V1";
const model = VERSE_MODELS[TIER];

if (!model) {
  console.error(`\nUnknown tier ${TIER}. Use V1, V2 or V3.\n`);
  process.exit(1);
}

const key =
  TIER === "V1"
    ? process.env.VERSE_V1_API_KEY
    : TIER === "V2"
      ? process.env.VERSE_V2_API_KEY
      : process.env.VERSE_V3_API_KEY;

const router =
  model.provider === "anthropic"
    ? anthropicRouter(fetch, key)
    : model.provider === "google"
      ? googleRouter(fetch, key)
      : openaiRouter(fetch, key);

const embedder = openaiEmbeddingRouter(
  fetch,
  process.env.VERSE_EMBEDDING_API_KEY,
);

const business = await withCompany(companyId, (db) =>
  db.company.findFirst({ select: { name: true } }),
);

if (!business) {
  console.error(`\nNo company ${companyId}.\n`);
  process.exit(1);
}

const results = [];

for (const question of QUESTIONS) {
  const embedded = await embedder.embed([question.text]);

  if (embedded.kind === "failed") {
    console.error(`\nEmbedding failed: ${embedded.reason}\n`);
    process.exit(1);
  }

  const chunks = await withCompany(companyId, (db, scoped) =>
    retrieveChunks(db, scoped, {
      knowledgeBaseId,
      embedding: embedded.vectors[0],
    }),
  );

  const grounding = groundingFor(chunks, SIMILARITY_FLOOR);

  const escalation = escalationBefore({
    message: question.text,
    grounded: grounding.kind === "grounded",
    turnsWithoutProgress: 0,
  });

  /*
   * A handoff is the OUTCOME being measured for the five, so it is recorded as
   * one rather than treated as a failure to answer.
   */
  if (escalation || grounding.kind !== "grounded") {
    results.push({
      question,
      outcome: "handed_off",
      reason: escalation ?? "no_grounding",
      best: grounding.kind === "ungrounded" ? grounding.best : null,
      answer: null,
    });
    continue;
  }

  const completion = await router.complete({
    system: buildSystemPrompt({
      goal: "Answer questions about this business from the passages provided.",
      businessName: business.name,
      chunks: grounding.chunks,
    }),
    turns: [{ role: "customer", text: question.text }],
    maxOutputTokens: 512,
  });

  results.push({
    question,
    outcome: completion.kind === "answered" ? "answered" : "handed_off",
    reason: completion.kind === "answered" ? null : completion.kind,
    best: grounding.chunks[0]?.similarity ?? null,
    answer: completion.kind === "answered" ? completion.text : null,
    latencyMs: completion.latencyMs,
    usage: completion.kind === "answered" ? completion.usage : null,
  });
}

/* ------------------------------------------------------------------------- *
 * The verdict
 * ------------------------------------------------------------------------- */

const answerable = results.filter((r) => r.question.answerable);
const unanswerable = results.filter((r) => !r.question.answerable);

const answeredCount = answerable.filter((r) => r.outcome === "answered").length;
const handedOffCount = unanswerable.filter(
  (r) => r.outcome === "handed_off",
).length;

console.log("\n=== Verse acceptance metric ===\n");
console.log(`  tier              ${TIER} (${model.label})`);
console.log(`  floor             ${SIMILARITY_FLOOR}`);
console.log(`  run id            ${randomUUID()}\n`);

for (const result of results) {
  const mark =
    result.question.answerable === (result.outcome === "answered") ? "ok  " : "FAIL";
  const score = result.best === null ? "  -  " : result.best.toFixed(3);
  console.log(`  ${mark} ${score}  ${result.question.text}`);
  if (result.answer) console.log(`         -> ${result.answer.slice(0, 120)}`);
  if (result.reason) console.log(`         -> handed off: ${result.reason}`);
}

console.log("");
console.log(`  answered and grounded   ${answeredCount} / ${answerable.length}   (need 17)`);
console.log(`  handed off              ${handedOffCount} / ${unanswerable.length}   (need ${unanswerable.length})`);
console.log("");

/*
 * The grounded answers still need a human to read them.
 *
 * This script can prove a passage cleared the floor and a model produced text.
 * It cannot prove the text is CORRECT - that is a judgement about the tenant's
 * own business, and a model marking its own homework is not a measurement.
 *
 * So the pass here is necessary and not sufficient, and the script says so
 * rather than letting a green line stand in for somebody having read twenty
 * answers.
 */
const passed =
  answeredCount >= 17 && handedOffCount === unanswerable.length;

if (!passed) {
  console.error("  METRIC FAILED.\n");
  process.exit(1);
}

console.log("  Retrieval and handoff pass.");
console.log("");
console.log("  NOT YET COMPLETE: read the twenty answers above and confirm each");
console.log("  is actually correct. This script proves a passage cleared the");
console.log("  floor and a model wrote something - it cannot prove the something");
console.log("  is true, and a model marking its own homework is not a");
console.log("  measurement. Then set floor.ts status to \"measured\".");
console.log("");
