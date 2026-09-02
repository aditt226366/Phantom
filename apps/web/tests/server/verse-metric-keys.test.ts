import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The acceptance metric refuses on the keys it will actually use, and no others.
 *
 * ---------------------------------------------------------------------------
 * Why this is worth a spawned process
 * ---------------------------------------------------------------------------
 *
 * The metric checked all four VERSE_KEY_VARS - V1, V2, V3 and the embedding
 * key - and it calls exactly two of them: one generation tier and the embedder.
 * It never touches the other two providers.
 *
 * That is not a cosmetic error in a message. It made the phase's acceptance
 * criterion unreachable without credentials for two providers it does not use,
 * and it named four variables when two would do - which reads as "this needs
 * far more setup than it does", and is precisely how a check ends up skipped
 * rather than satisfied. The 20/5 is the only thing in the phase that measures
 * whether the similarity floor is in the right place.
 *
 * Asserted by running the real script, because the property is about what that
 * file does before it does anything else. A unit test would need the refusal
 * extracted into a function, and the thing worth guarding is the script's own
 * first twenty lines - including that they run before any provider is
 * constructed.
 *
 * No network: with keys present the script gets as far as looking up a company
 * that does not exist and exits there, which is well before any provider call.
 * The keys below are obvious fakes for the same reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const repoRoot = resolve(webRoot, "..", "..");
const script = join(webRoot, "scripts", "verse-metric.mjs");

/*
 * tsx's real entry, not the `.bin` shim.
 *
 * Two reasons, both already recorded elsewhere in this repository: npm hoists
 * tsx to the root so it is not under apps/web/node_modules at all, and Node 24
 * refuses to spawn a `.cmd` without a shell - which is why scripts/test-floor.mjs
 * points at `node_modules/vitest/vitest.mjs` rather than going through npx.
 */
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const FAKE = "not-a-real-key-for-a-refusal-test";

function runMetric(env: Record<string, string | undefined>) {
  const result = spawnSync(
    process.execPath,
    [tsx, script, "co_x", "kb_x"],
    {
      cwd: webRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        VERSE_V1_API_KEY: undefined,
        VERSE_V2_API_KEY: undefined,
        VERSE_V3_API_KEY: undefined,
        VERSE_EMBEDDING_API_KEY: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
    },
  );

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("which keys the metric demands", () => {
  it("names the embedding key alone when only that is missing", () => {
    /*
     * THE case. V1 is set, the embedder is not, and the two tiers the metric
     * never calls are also not - so a correct refusal names exactly one
     * variable.
     */
    const output = runMetric({ VERSE_V1_API_KEY: FAKE });

    expect(output).toContain("VERSE_EMBEDDING_API_KEY");
    expect(output).not.toContain("VERSE_V2_API_KEY");
    expect(output).not.toContain("VERSE_V3_API_KEY");
  });

  it("names V1 when the tier's own key is missing", () => {
    const output = runMetric({ VERSE_EMBEDDING_API_KEY: FAKE });

    expect(output).toContain("VERSE_V1_API_KEY");
    expect(output).not.toContain("VERSE_V2_API_KEY");
    expect(output).not.toContain("VERSE_V3_API_KEY");
  });

  it("names the chosen tier rather than V1 when one is selected", () => {
    /*
     * The refusal follows VERSE_METRIC_TIER. Running the metric on V2 needs
     * V2's key, and still needs nothing from V1 or V3.
     */
    const output = runMetric({
      VERSE_METRIC_TIER: "V2",
      VERSE_EMBEDDING_API_KEY: FAKE,
    });

    expect(output).toContain("VERSE_V2_API_KEY");
    expect(output).not.toContain("VERSE_V1_API_KEY");
    expect(output).not.toContain("VERSE_V3_API_KEY");
  });

  it("gets past the refusal entirely once both keys are present", () => {
    /*
     * The other direction, and the one that stops this passing vacuously: a
     * refusal that never fires would satisfy every "not.toContain" above.
     *
     * With both keys set the script proceeds and fails on the company instead,
     * which is the next thing it checks and still short of any provider call.
     */
    const output = runMetric({
      VERSE_V1_API_KEY: FAKE,
      VERSE_EMBEDDING_API_KEY: FAKE,
    });

    expect(output).not.toContain("THE VERSE ACCEPTANCE METRIC CANNOT RUN");
    expect(output).toContain("No company");
  });
});
