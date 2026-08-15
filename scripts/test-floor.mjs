import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run the suite, and refuse a run that collected fewer tests than it should.
 *
 * This guards a specific gap, and it is worth being exact about which - the
 * obvious answer is wrong.
 *
 * A dying worker is NOT the gap. Vitest reports an unhandled worker exit as a
 * failed test file and exits non-zero, so `npm run verify` already stops. That
 * was measured, by killing a worker on purpose: exit 1, "Test Files 1 failed".
 * A run that looks green after a crash is a run whose exit code nobody read.
 *
 * The gap is tests that are never COLLECTED. A deleted file, a project quietly
 * dropped from vitest.config.mts, a broken include glob: vitest has nothing to
 * run, nothing fails, and it exits 0. Measured too - deleting one file gives
 * "Tests 580 passed" and exit 0, which is as green as a full run looks.
 *
 * numTotalTests counts collected tests, which is exactly the number that moves
 * in that case and exactly the number that does not move when a worker dies
 * mid-run. So the two failure modes are covered by two different mechanisms,
 * and this is the one for the silent half.
 *
 * The floor is a committed number, like GLOBAL_TABLES or OUT_OF_BAND_DDL: it
 * rises when suites are added, and raising it is a deliberate diff.
 *
 * A floor and not an exact match, deliberately. An exact count would fail on
 * every commit that adds a test, which trains people to edit the number without
 * reading it - and a number nobody reads is the failure this exists to prevent.
 */
const MINIMUM_TESTS = 734;

const out = mkdtempSync(path.join(tmpdir(), "wa-os-test-"));
const report = path.join(out, "report.json");

/*
 * vitest.mjs directly rather than through npx. Node 24 refuses to spawn a .cmd
 * without a shell, so `npx.cmd` fails outright on Windows, and going through a
 * shell to work around that would mean quoting the report path by hand.
 *
 * Both reporters: the default one so a human still sees the run, the json one
 * so this script can count. --outputFile.json is the per-reporter form and is
 * required once there is more than one reporter.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const vitest = path.resolve(here, "..", "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${report}`,
  ],
  { stdio: "inherit" },
);

let total = null;
try {
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  total = parsed.numTotalTests ?? null;
} catch (cause) {
  console.error(
    `\nCould not read the test report at ${report}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (result.status !== 0) {
  console.error("\nTests failed.");
  process.exit(result.status ?? 1);
}

if (total === null) {
  console.error(
    "\nThe suite passed but produced no readable report, so the test count " +
      "could not be checked. Treating that as a failure: an unreadable report " +
      "is the same evidence as a short one.",
  );
  process.exit(1);
}

if (total < MINIMUM_TESTS) {
  console.error(
    [
      "",
      `Only ${total} tests were collected; at least ${MINIMUM_TESTS} were expected.`,
      "",
      "Every test that ran passed, which is why this is not already red. Tests",
      "that are never collected are absences rather than failures, so look for",
      "something that stopped them being found: a deleted file, a project",
      "missing from vitest.config.mts, or an include glob that no longer",
      "matches.",
      "",
      "If tests were deliberately removed, lower MINIMUM_TESTS in",
      "scripts/test-floor.mjs in the same commit, and say why.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`\n${total} tests ran (floor ${MINIMUM_TESTS}).`);
