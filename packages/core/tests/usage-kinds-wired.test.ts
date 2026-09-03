import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { USAGE_KINDS, USAGE_PRICES } from "../src/usage.ts";

/**
 * Every declared usage kind is actually written somewhere.
 *
 * ---------------------------------------------------------------------------
 * A priced kind nothing writes is unattributed spend
 * ---------------------------------------------------------------------------
 *
 * `verse.embedding` was in USAGE_KINDS and in USAGE_PRICES from the day the
 * phase shipped, and no code ever wrote one. Ingestion made real, billable
 * OpenAI calls - a 2,000-chunk PDF is several of them - and recorded nothing.
 * The whole suite passed, `db:verify` passed, the screenshots passed, and the
 * declaration read exactly like a wired feature.
 *
 * That is not a tidiness problem. models.ts argues that platform-level provider
 * keys are safe to expose to per-tenant traffic BECAUSE every call is
 * attributed to the company that caused it. A kind nothing writes is a hole in
 * the one thing making that argument true, and it is invisible from every
 * direction: the constant exists, the price exists, the column exists, and the
 * row does not.
 *
 * It is the third declared-but-unwired surface this repository has shipped -
 * after `conversations.assigned_user_id`, a column nothing wrote for nine
 * phases while every reader treated null as "nobody has picked this up", and
 * the run-state chips whose order was declared nowhere. The conventions already
 * say "a column nothing writes is not a feature, and its readers are lying".
 * This is that rule, enforced.
 *
 * ---------------------------------------------------------------------------
 * Production source only
 * ---------------------------------------------------------------------------
 *
 * Tests are excluded deliberately. A kind written only by a test is not wired -
 * it is a kind with a test and no caller, which is the exact state this exists
 * to catch. `integration.verify` appears in several test files and would have
 * masked itself.
 */

/**
 * Kinds that are declared and priced and that nothing writes, each with the
 * reason and what would end it.
 *
 * A Map rather than a Set, so an entry cannot be added without saying why - the
 * shape GLOBAL_TABLES, ORDER_INDEPENDENT and APPEND_ONLY_TABLES all use. Every
 * line here is a known hole in attribution, not a decision that the hole is
 * fine, and shrinking this list is the point of having it.
 *
 * Writing this list was itself the finding. `verse.embedding` was the one kind
 * anybody had noticed; the check found four more the moment it ran, including
 * the product's single largest cost.
 */
const KNOWN_UNWIRED = new Map<string, string>([
  [
    "integration.test",
    /*
     * Superseded rather than missing. Save & Verify and Test Connection were
     * unified into one path - admin/actions.ts says so in as many words -
     * and it records integration.verify. Nothing can write this kind, because
     * the operation it named no longer exists separately.
     *
     * Ends by DELETING the kind and its price entry, not by wiring one. Left
     * here rather than removed in the same commit as the check, because
     * deleting a usage kind is a decision about the invoice and belongs in a
     * diff about that.
     */
    "superseded by integration.verify when Test Connection was unified with Save & Verify; should be deleted, not wired",
  ],
  [
    "whatsapp.conversation.marketing",
    "Meta's per-conversation charge. See the note below - the data arrives and is dropped.",
  ],
  ["whatsapp.conversation.utility", "as marketing"],
  ["whatsapp.conversation.authentication", "as marketing"],
  [
    "whatsapp.conversation.service",
    /*
     * The largest real cost in the product, and nothing records any of it.
     *
     * Meta bills per 24-hour conversation window, per category, and the status
     * webhook carries the pricing block that says which. payload.ts reads
     * `status.conversation?.id` and drops the category beside it;
     * `conversationUsageKind` exists to map one and is called from a test and
     * nowhere else.
     *
     * So this is not "not built yet" in the ordinary sense - the data reaches
     * the webhook and is discarded. Ends by parsing the pricing block, deduping
     * on Meta's conversation id, and recording the kind that function already
     * returns. Its own diff: it changes what the webhook stores.
     */
    "Meta's per-conversation charge; the category arrives in the status webhook and payload.ts drops it, and conversationUsageKind is called only from a test",
  ],
]);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/** Where a recordUsage call can legitimately live. */
const ROOTS = [
  join(repoRoot, "apps", "web", "app"),
  join(repoRoot, "apps", "web", "lib"),
  join(repoRoot, "apps", "web", "scripts"),
  join(repoRoot, "apps", "worker", "src"),
  join(repoRoot, "packages", "db", "src"),
];

const SKIP_DIRS = new Set(["generated", "node_modules", ".next", "tests"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
      continue;
    }

    if (/\.(tsx?|mjs)$/.test(entry)) out.push(full);
  }

  return out;
}

/** The balanced `{ … }` starting at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;

  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }

  return src.slice(open);
}

interface CallSite {
  kind: string;
  where: string;
}

/**
 * Every `recordUsage(…, { kind: "…" })` in production source.
 *
 * The `kind:` is matched at the START of a line, after nothing but whitespace,
 * and that is the point rather than an accident of formatting. This repository
 * has been caught four times by a source check matching its own explanation:
 * prose about usage kinds says `kind: "verse.reply"` freely - the comment
 * directly above the ingestion call site does - but a line inside a block
 * comment begins with `*`, and a single-line one begins with `//` or a slash
 * and a star. None of them can begin with `kind:`.
 */
function callSites(file: string): CallSite[] {
  const src = readFileSync(file, "utf8");
  const found: CallSite[] = [];

  for (const match of src.matchAll(/recordUsage\(/g)) {
    const open = src.indexOf("{", match.index!);
    if (open === -1) continue;

    const body = balanced(src, open);
    const kind = /^[ \t]*kind:\s*"([^"]+)"/m.exec(body);
    if (!kind) continue;

    const line = src.slice(0, match.index!).split("\n").length;
    found.push({
      kind: kind[1]!,
      where: `${relative(repoRoot, file).replace(/\\/g, "/")}:${line}`,
    });
  }

  return found;
}

const sites = ROOTS.flatMap((root) => sourceFiles(root)).flatMap(callSites);

describe("every usage kind is wired to something that writes it", () => {
  it("finds the call sites, so an empty sweep cannot pass this suite", () => {
    /*
     * The guard that makes the assertion below mean something. A broken path or
     * a regex that stopped matching gives an empty list, and "every kind is
     * written somewhere" is not vacuously true of none - it fails loudly - but
     * the failure would name every kind and point at nothing, which sends the
     * next person to the wrong file.
     */
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it("writes a row for every kind it declares", () => {
    /*
     * THE assertion. Named per kind, not "some kind is unwired": the failure
     * has to say verse.embedding so the next person opens the ingestion job
     * rather than reading the whole list to work out which one is missing.
     */
    const written = new Set(sites.map((site) => site.kind));
    const unwired = USAGE_KINDS.filter(
      (kind) => !written.has(kind) && !KNOWN_UNWIRED.has(kind),
    );

    expect(
      [...unwired].sort(),
      "these kinds are declared and priced, and nothing writes one - which is a provider call nobody is attributing. Wire a recordUsage call, or delete the kind and its price entry, or add it to KNOWN_UNWIRED with a reason",
    ).toEqual([]);
  });

  it("keeps KNOWN_UNWIRED honest, so a wired kind cannot sit in it", () => {
    /*
     * The list fails in BOTH directions, like GLOBAL_TABLES.
     *
     * A waiver that outlives the problem is worse than no waiver: it reads as a
     * standing decision that the hole is acceptable, and the next person adding
     * a kind copies the nearest example. Wiring one of these has to remove its
     * entry, and this is what makes that mandatory rather than tidy.
     */
    const written = new Set(sites.map((site) => site.kind));
    const stale = [...KNOWN_UNWIRED.keys()].filter((kind) => written.has(kind));

    expect(
      stale.sort(),
      "these kinds ARE written now, so remove them from KNOWN_UNWIRED",
    ).toEqual([]);
  });

  it("does not waive a kind that no longer exists", () => {
    /* And an entry for a deleted kind is a note about nothing, which is how a
       list like this stops being read. */
    const declared = new Set<string>(USAGE_KINDS);
    const phantom = [...KNOWN_UNWIRED.keys()].filter(
      (kind) => !declared.has(kind),
    );

    expect(phantom.sort()).toEqual([]);
  });

  it("declares every kind it writes", () => {
    /*
     * The other direction, and it is not symmetric with the one above: a call
     * site naming a kind outside USAGE_KINDS writes a row that findPrice cannot
     * match, so it lands unpriced with a reason - silently, because recordUsage
     * deliberately never throws. A typo in a kind string is exactly that shape
     * and would otherwise reach the invoice.
     *
     * The type would normally stop this, and does not everywhere: the metric
     * and probe scripts are .mjs, and `as never` casts exist in the codebase.
     */
    const declared = new Set<string>(USAGE_KINDS);
    const undeclared = sites.filter((site) => !declared.has(site.kind));

    expect(
      undeclared.map((site) => `${site.kind} at ${site.where}`).sort(),
      "these call sites write a kind USAGE_KINDS does not declare, so the row lands unpriced with no price entry to match",
    ).toEqual([]);
  });
});

describe("prices and kinds describe the same set", () => {
  it("prices only kinds that exist", () => {
    /*
     * A price entry for a kind nothing declares can never match a row, so the
     * price is a decision that has no effect and reads like one that does.
     */
    const declared = new Set<string>(USAGE_KINDS);
    const orphaned = [...USAGE_PRICES.values()]
      .map((price) => price.kind)
      .filter((kind) => !declared.has(kind));

    expect([...new Set(orphaned)].sort()).toEqual([]);
  });

  it("prices every kind that exists, at the active version", () => {
    /*
     * The direction that matters for a bill. An unpriced kind is not an error
     * at runtime - recordUsage writes a null cost and a reason rather than
     * failing a call that already happened - so it is invisible until somebody
     * asks why a month's spend looks low.
     *
     * Zero counts as priced. The comment on USAGE_PRICES makes that argument:
     * an explicit zero is a decision, an absent entry is an oversight, and only
     * one of them is distinguishable here.
     */
    const priced = new Set(
      [...USAGE_PRICES.values()].map((price) => price.kind),
    );
    const unpriced = USAGE_KINDS.filter((kind) => !priced.has(kind));

    expect([...unpriced].sort()).toEqual([]);
  });
});
