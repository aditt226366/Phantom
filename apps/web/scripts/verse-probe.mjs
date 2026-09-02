import "./_load-env.mjs";

/**
 * One live generation call through the real router, against the real provider.
 *
 * ===========================================================================
 * WHY A RECORDED-RESPONSE TEST IS NOT THIS
 * ===========================================================================
 *
 * Every test of `anthropicRouter` injects a fetch that returns a body we wrote.
 * Those prove the parser matches WHAT WE RECORDED. They cannot prove it matches
 * what Anthropic sends, and the two diverge silently: a renamed field arrives as
 * `undefined`, `usage.input_tokens ?? 0` turns it into a zero, and the adapter
 * reports a successful answer that cost nothing. Nothing throws. The bill is the
 * only thing that disagrees.
 *
 * So this makes one real call and reports what came back, including the fields
 * the parser does NOT read - because a field that moved is invisible from the
 * parsed side.
 *
 *   npx tsx --conditions=react-server scripts/verse-probe.mjs [companyId]
 *
 * With a companyId it also writes and reads back a usage_events row through the
 * ordinary path, which is the other half of "end to end": the model call is
 * only safe to make on a platform-level key because every call is attributed.
 */

import {
  VERSE_MODELS,
  anthropicRouter,
  buildSystemPrompt,
  groundingFor,
} from "@whatsapp-os/core/verse";
import { usageDedupeKey } from "@whatsapp-os/core";
import { recordUsage, withCompany } from "@whatsapp-os/db";

const KEY = process.env.VERSE_V1_API_KEY;

if (!KEY) {
  console.error(
    [
      "",
      "VERSE_V1_API_KEY is not set in .env.",
      "",
      "Note that .env.example is NOT read for secrets - it is the tracked",
      "template a fresh clone copies, and a real key there would be committed.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const companyId = process.argv[2];

/* ------------------------------------------------------------------------- *
 * A hand-supplied passage, so grounding is decided rather than incidental
 * ------------------------------------------------------------------------- */

/*
 * Deliberately a fact no model can know: an invented delivery window for an
 * invented business. If the answer contains it, the answer came from the
 * context rather than from the model's own priors - which is the property the
 * whole grounding design rests on and the one a live call can actually check.
 */
const PASSAGE =
  "Kamat Textiles delivers across Maharashtra in 3-5 working days. " +
  "Orders above Rs 4,000 ship free. Collections can be booked at the " +
  "Pune store on Tuesdays and Thursdays only.";

const chunks = [
  {
    chunkId: "probe-1",
    sources: [{ documentId: "probe-doc", documentTitle: "Delivery", seq: 0 }],
    content: PASSAGE,
    similarity: 0.82,
  },
];

const grounding = groundingFor(chunks);

const system = buildSystemPrompt({
  businessName: "Kamat Textiles",
  goal: "Answer questions about delivery and book collections.",
  chunks,
});

const QUESTION = "How long does delivery take, and when can I book a collection?";

/* ------------------------------------------------------------------------- *
 * The call
 * ------------------------------------------------------------------------- */

const model = VERSE_MODELS.V1;

console.log("");
console.log("  tier              V1");
console.log(`  provider          ${model.provider}`);
console.log(`  model string      ${model.model}`);
console.log(`  key var           ${model.keyVar} (set, ${KEY.length} chars)`);
console.log(`  grounding         ${grounding.kind}`);
console.log("");

/*
 * The SAME fetch the worker uses, wrapped only to capture the raw body.
 *
 * Wrapping rather than re-implementing the request: the point is to exercise
 * anthropicRouter's own URL, headers, body shape and parser. A probe that built
 * its own request would verify the probe.
 */
let rawBody = null;
let httpStatus = null;

const capturingFetch = async (url, init) => {
  const response = await fetch(url, init);
  httpStatus = response.status;

  const text = await response.text();
  try {
    rawBody = JSON.parse(text);
  } catch {
    rawBody = { unparseable: text.slice(0, 2000) };
  }

  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const router = anthropicRouter(capturingFetch, KEY);

const started = Date.now();
const outcome = await router.complete({
  system,
  turns: [{ role: "customer", text: QUESTION }],
  maxOutputTokens: 300,
});
const wallMs = Date.now() - started;

/* ------------------------------------------------------------------------- *
 * What came back
 * ------------------------------------------------------------------------- */

console.log(`  HTTP              ${httpStatus}`);
console.log(`  outcome.kind      ${outcome.kind}`);
console.log(`  latency (adapter) ${outcome.latencyMs} ms`);
console.log(`  latency (wall)    ${wallMs} ms`);

if (outcome.kind === "answered") {
  console.log(`  input tokens      ${outcome.usage.inputTokens}`);
  console.log(`  output tokens     ${outcome.usage.outputTokens}`);
  console.log("");
  console.log("  --- answer ---");
  console.log(
    outcome.text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  console.log("");

  /*
   * Did the answer use the passage? Not a grading rubric - one invented fact,
   * looked for literally. A live call that answers from the model's own priors
   * rather than from the context is the failure this layer exists to prevent,
   * and it would look identical from the outcome shape alone.
   */
  /*
   * A dash class, not a literal hyphen.
   *
   * The first run of this probe reported `false` for a delivery window the
   * answer had quoted correctly: the passage says "3-5" with a hyphen and the
   * model wrote "3–5" with an en dash. A literal-hyphen regex called a grounded
   * answer ungrounded - the same class of mistake this file exists to catch,
   * made by the checker rather than by the parser.
   */
  const usedContext = /3\s*[-‐-―−]\s*5 working days/i.test(
    outcome.text,
  );
  const usedTuesday = /tuesday/i.test(outcome.text);
  console.log(`  quotes the passage's delivery window   ${usedContext}`);
  console.log(`  quotes the passage's collection days   ${usedTuesday}`);
} else {
  console.log(`  reason            ${outcome.reason}`);
}

/* ------------------------------------------------------------------------- *
 * The parser, against the actual response
 * ------------------------------------------------------------------------- */

console.log("");
console.log("  --- shape the parser depends on ---");

const body = rawBody ?? {};

function report(label, present, detail) {
  console.log(`  ${present ? "ok " : "NO "} ${label.padEnd(34)} ${detail}`);
}

report(
  "content[] present",
  Array.isArray(body.content),
  Array.isArray(body.content) ? `${body.content.length} block(s)` : typeof body.content,
);
report(
  'a block with type === "text"',
  Array.isArray(body.content) && body.content.some((b) => b?.type === "text"),
  Array.isArray(body.content)
    ? `types: ${body.content.map((b) => b?.type).join(", ")}`
    : "-",
);
report("stop_reason present", typeof body.stop_reason === "string", String(body.stop_reason));
report(
  "usage.input_tokens is a number",
  typeof body.usage?.input_tokens === "number",
  String(body.usage?.input_tokens),
);
report(
  "usage.output_tokens is a number",
  typeof body.usage?.output_tokens === "number",
  String(body.usage?.output_tokens),
);

/*
 * Everything the response carries that the parser does NOT read.
 *
 * The half a recorded fixture can never show: a field the provider renamed is
 * absent from the parsed side and looks like a zero, and the only way to notice
 * is to look at what actually arrived.
 */
const KNOWN = new Set(["content", "stop_reason", "usage", "id", "type", "role", "model"]);
const unread = Object.keys(body).filter((k) => !KNOWN.has(k));
console.log(`  response keys     ${Object.keys(body).join(", ")}`);
console.log(`  model echoed back ${body.model ?? "(absent)"}`);
if (unread.length > 0) console.log(`  keys we ignore    ${unread.join(", ")}`);

const usageKeys = body.usage ? Object.keys(body.usage) : [];
console.log(`  usage keys        ${usageKeys.join(", ")}`);

/*
 * The whole usage object, values included, because the key names alone
 * understate what is at stake here.
 *
 * The adapter reads `input_tokens` and `output_tokens`. Anthropic also returns
 * `cache_creation_input_tokens` and `cache_read_input_tokens`, and those are
 * NOT part of `input_tokens` - they are a separate split of the billable input.
 * Nothing in this system enables prompt caching today, so both are zero and the
 * adapter is right. The day anything turns caching on, `input_tokens` stops
 * being the input bill, the usage row undercounts, and every recorded-response
 * test stays green because the fixtures were recorded before it.
 *
 * That is the shape a recorded fixture cannot warn about, and the reason this
 * prints fields the parser ignores rather than only the ones it reads.
 */
console.log(`  usage in full     ${JSON.stringify(body.usage)}`);

/* ------------------------------------------------------------------------- *
 * The usage_events row
 * ------------------------------------------------------------------------- */

if (!companyId) {
  console.log("");
  console.log("  No companyId given, so no usage_events row was written.");
  console.log("  Pass one to exercise that half:  ... verse-probe.mjs <companyId>");
  console.log("");
  process.exit(0);
}

const dedupeKey = usageDedupeKey("verse.reply", `probe-${Date.now()}`);

const written = await withCompany(companyId, (db, scoped) =>
  recordUsage(db, scoped, { kind: "verse.reply", dedupeKey }),
);

const row = await withCompany(companyId, (db, scoped) =>
  db.usageEvent.findFirst({
    where: { companyId: scoped, dedupeKey },
    select: {
      id: true,
      kind: true,
      quantity: true,
      currency: true,
      costMicros: true,
      priceVersion: true,
      occurredAt: true,
    },
  }),
);

/*
 * cost_micros is a bigint on BOTH the returned value and the row, and
 * JSON.stringify throws on one rather than rendering it - which is how this
 * probe failed its own first run, after the live call had already succeeded.
 */
const bigints = (_key, value) =>
  typeof value === "bigint" ? `${value}n` : value;

console.log("");
console.log("  --- usage_events ---");
console.log(`  recordUsage said  ${JSON.stringify(written, bigints)}`);
console.log(
  `  row               ${JSON.stringify(row, bigints, 2).split("\n").join("\n  ")}`,
);
console.log("");

process.exit(0);
