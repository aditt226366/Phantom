import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  VERSE_EMBEDDING,
  VERSE_KEY_VARS,
  VERSE_MODELS,
  VERSE_SCORING_TIER,
  VERSE_TIERS,
  verseModel,
} from "../src/verse/models.ts";

/**
 * The model strings are written once, and this is what keeps them that way.
 *
 * A model id scattered across an adapter, a test fixture, a prompt default and
 * a migration comment is one that gets half-updated. The half that is missed
 * keeps calling the old model - which still answers, still bills, and still
 * looks right on a dashboard reporting the new model's name. Nothing fails.
 *
 * So the assertion is not "the constant exists". It is that the LITERAL appears
 * in exactly one source file, which is the property that actually stops the
 * drift.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/** Source we own. Generated Prisma output and node_modules are not ours. */
const SEARCH_ROOTS = [
  resolve(repoRoot, "packages", "core", "src"),
  resolve(repoRoot, "packages", "db", "src"),
  resolve(repoRoot, "apps", "web", "app"),
  resolve(repoRoot, "apps", "web", "lib"),
  resolve(repoRoot, "apps", "worker", "src"),
];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "node_modules" || entry === "generated") continue;
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Comments stripped before matching, because this repository has flagged its
 * own explanations at least three times - no-raw-prisma.test.ts says so about
 * import specifiers, the admin-db narrowness check hit it, and
 * feature-gate-coverage.test.ts was satisfied by an unused import.
 *
 * A comment that MENTIONS a model string is documentation. Only a literal in
 * code is a second definition.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the Verse model strings", () => {
  const files = SEARCH_ROOTS.flatMap(sourceFiles);

  it("finds source to search, so a silent zero cannot pass this suite", () => {
    /*
     * The guard that makes every assertion below mean something. A broken path
     * would give an empty file list, and "appears in exactly one file" would
     * fail loudly - but "appears in at most one" would pass, and a later
     * relaxation of these assertions would go unnoticed.
     */
    expect(files.length).toBeGreaterThan(100);
  });

  for (const tier of VERSE_TIERS) {
    it(`writes ${tier}'s model id in exactly one file`, () => {
      const literal = VERSE_MODELS[tier].model;
      const hits = files.filter((file) =>
        stripComments(readFileSync(file, "utf8")).includes(literal),
      );

      expect(
        hits.map((f) => f.slice(repoRoot.length + 1).replace(/\\/g, "/")),
      ).toEqual(["packages/core/src/verse/models.ts"]);
    });
  }

  it("writes the embedding model id in exactly one file", () => {
    const hits = files.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes(VERSE_EMBEDDING.model),
    );

    expect(
      hits.map((f) => f.slice(repoRoot.length + 1).replace(/\\/g, "/")),
    ).toEqual(["packages/core/src/verse/models.ts"]);
  });

  it("carries no date suffix on any model id", () => {
    /*
     * A recalled `-20251114` produces a 404 at the provider rather than a
     * validation error here, and it is exactly the shape a model string picks
     * up when somebody "makes it explicit".
     */
    for (const tier of VERSE_TIERS) {
      expect(VERSE_MODELS[tier].model).not.toMatch(/-\d{8}$/);
    }
    expect(VERSE_EMBEDDING.model).not.toMatch(/-\d{8}$/);
  });
});

describe("the tiers", () => {
  it("gives every tier a distinct model, provider and key variable", () => {
    const models = VERSE_TIERS.map((t) => VERSE_MODELS[t].model);
    const keys = VERSE_TIERS.map((t) => VERSE_MODELS[t].keyVar);

    expect(new Set(models).size).toBe(VERSE_TIERS.length);
    expect(new Set(keys).size).toBe(VERSE_TIERS.length);
  });

  it("labels a tier without naming its provider or model", () => {
    /*
     * The whole point of the Verse naming: a tenant never learns which model
     * answered. A label leaking "claude" or "gpt" would put it on a settings
     * screen and in a support conversation, and take the substitution freedom
     * away permanently.
     */
    for (const tier of VERSE_TIERS) {
      const { label, model, provider } = VERSE_MODELS[tier];
      expect(label.toLowerCase()).not.toContain(provider);
      expect(label.toLowerCase()).not.toContain(model.split("-")[0]!);
      expect(label).toContain("Verse");
    }
  });

  it("scores on a fixed tier rather than the tenant's choice", () => {
    /*
     * Scoring runs on every inbound message of every campaign, so following the
     * tenant's tier would make the most expensive model in the system also the
     * most frequently called. Nothing about choosing V1 for answers says a
     * frontier model should decide HOT/WARM/COLD.
     */
    expect(VERSE_TIERS).toContain(VERSE_SCORING_TIER);
  });

  it("resolves a tier to its model", () => {
    expect(verseModel("V1").model).toBe(VERSE_MODELS.V1.model);
  });
});

describe("the embedding pin", () => {
  it("names every key variable the phase needs", () => {
    expect(VERSE_KEY_VARS).toHaveLength(4);
    expect(VERSE_KEY_VARS).toContain(VERSE_EMBEDDING.keyVar);
    for (const tier of VERSE_TIERS) {
      expect(VERSE_KEY_VARS).toContain(VERSE_MODELS[tier].keyVar);
    }
  });

  it("pins a positive dimension count and a version", () => {
    expect(VERSE_EMBEDDING.dimensions).toBeGreaterThan(0);
    expect(Number.isInteger(VERSE_EMBEDDING.dimensions)).toBe(true);
    expect(VERSE_EMBEDDING.version).toBeGreaterThanOrEqual(1);
  });
});
