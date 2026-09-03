import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
 * Kinds written through a COMPUTED expression, which this check cannot see.
 *
 * `recordConversationCharge` writes `kind` from `conversationUsageKind(category)`
 * - it has to, because the category arrives from Meta at runtime and the four
 * kinds differ only by it. A source scan looking for `kind: "…"` will never find
 * those, and loosening it to match a variable would make it match every
 * recordUsage call and assert nothing.
 *
 * So this is an escape hatch, and it is deliberately not a waiver: each entry
 * names the file that writes the kind and the test that PROVES it does, and
 * both claims are checked below. An entry cannot be fiction, and it cannot
 * outlive the code it points at.
 *
 * This is not the place for a kind nothing writes. That is a failure, and the
 * assertion above is what produces it.
 */
const COMPUTED_KIND_SITES = new Map<
  string,
  { writtenBy: string; provenBy: string }
>(
  (
    [
      "whatsapp.conversation.marketing",
      "whatsapp.conversation.utility",
      "whatsapp.conversation.authentication",
      "whatsapp.conversation.service",
    ] as const
  ).map((kind) => [
    kind,
    {
      /* One function, called by the live webhook and by the backfill, so the
         two cannot come to disagree about what a status callback means for the
         bill. */
      writtenBy: "packages/db/src/conversation-charges.ts",
      /* Asserts all four kinds land, from the four categories Meta sends. */
      provenBy: "packages/db/tests/conversation-charges.test.ts",
    },
  ]),
);

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
      (kind) => !written.has(kind) && !COMPUTED_KIND_SITES.has(kind),
    );

    expect(
      [...unwired].sort(),
      "these kinds are declared and priced, and nothing writes one - which is a provider call nobody is attributing. Wire a recordUsage call, or delete the kind and its price entry",
    ).toEqual([]);
  });

  it("points every computed-kind entry at a file that writes one", () => {
    /*
     * The escape hatch cannot be fiction. An entry claims a file writes the
     * kind through an expression; this checks that the file exists and calls
     * recordUsage at all, so a stale entry surviving a refactor is a failure
     * rather than a comment nobody reads.
     */
    const broken: string[] = [];

    for (const [kind, site] of COMPUTED_KIND_SITES) {
      const full = join(repoRoot, site.writtenBy);

      if (!existsSync(full)) {
        broken.push(`${kind}: ${site.writtenBy} does not exist`);
        continue;
      }

      if (!/recordUsage\(/.test(readFileSync(full, "utf8"))) {
        broken.push(`${kind}: ${site.writtenBy} no longer calls recordUsage`);
      }
    }

    expect(broken.sort()).toEqual([]);
  });

  it("points every computed-kind entry at a test that proves it", () => {
    /*
     * The other half, and the one that matters: a source file calling
     * recordUsage says nothing about WHICH kind it writes. The named test is
     * the evidence, so it has to exist and to mention the kind.
     */
    const broken: string[] = [];

    for (const [kind, site] of COMPUTED_KIND_SITES) {
      const full = join(repoRoot, site.provenBy);

      if (!existsSync(full)) {
        broken.push(`${kind}: ${site.provenBy} does not exist`);
        continue;
      }

      if (!readFileSync(full, "utf8").includes(kind)) {
        broken.push(`${kind}: ${site.provenBy} does not mention it`);
      }
    }

    expect(broken.sort()).toEqual([]);
  });

  it("does not register a computed kind that no longer exists", () => {
    /* An entry for a deleted kind is a note about nothing, which is how a list
       like this stops being read. */
    const declared = new Set<string>(USAGE_KINDS);
    const phantom = [...COMPUTED_KIND_SITES.keys()].filter(
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
