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
const MINIMUM_TESTS = 886;

/**
 * Two invocations, sequential, and `db` alone in the second.
 *
 * ---------------------------------------------------------------------------
 * Why this is kept, stated plainly: it did NOT fix the crash
 * ---------------------------------------------------------------------------
 *
 * This split was built to test a theory, and the theory was wrong. It is kept
 * on two much duller grounds - it costs nothing measurable, and a failure now
 * names which half of the suite died. Nothing here should be read as a fix,
 * and the next person to look at a red gate should suspect the machine before
 * this file or vitest.config.mts. See the conventions skill, "the machine
 * before the config".
 *
 * The theory: a forked worker dies with no stack, no file and no failing
 * assertion, and twice in a row the file that never reported was a `db` file -
 * a DIFFERENT one each time, `dashboard-ordering` then `number-refresh` -
 * while every one of the thirteen `worker` files had already finished. That
 * put the crash at the handover out of one project and into `db`.
 * `maxWorkers: 1` serialises files but puts no process boundary at that seam;
 * two processes do, since the first has exited with its pool torn down and its
 * forks reaped before the second is spawned.
 *
 * Measured over five gates with the split in place: two failures.
 *
 *   3  the `!db` process died WHOLE - exit 127, no JSON report at all
 *   4  a worker died INSIDE the `db` process, running alone, no other project
 *      in it. dashboard-rollup.test.ts never reported.
 *
 * Run 4 settles it. Cross-project overlap was not reduced, it was absent - one
 * project, one process - and a worker died anyway.
 *
 * Cost, measured the same session rather than against an older log: split
 * 228s, 233s, 236s, 232s; single invocation 243s, 226s. The same within noise.
 * An earlier reading that the split doubled the test step was a comparison
 * against a more lightly loaded machine, not a regression.
 *
 * ---------------------------------------------------------------------------
 * Two failure modes, not one - which is what forty retries had hidden
 * ---------------------------------------------------------------------------
 *
 * The gate's retry path treated every short, non-zero, nothing-actually-failing
 * run as the same event, and .git/gate-retries.log recorded forty of them under
 * one name. Run 3 separated them, and they are different things:
 *
 *   ONE WORKER DIES. "Worker exited unexpectedly", the run continues, and the
 *   files that never started go missing rather than failing. Vitest still
 *   exits non-zero and still writes its JSON report, so the count is readable
 *   and short.
 *
 *   THE WHOLE PROCESS DIES. Exit 127, no report written at all, the run simply
 *   stops mid-file. There is no vitest summary to read, which is why this file
 *   treats an unreadable report as a failure rather than skipping the check -
 *   an absent report is the same evidence as a short one.
 *
 * They are worth telling apart because only the first leaves a named file
 * behind to blame, and blaming it is how the last investigation ended up
 * looking at project transitions.
 *
 * ---------------------------------------------------------------------------
 * globalSetup runs twice, and that is safe here
 * ---------------------------------------------------------------------------
 *
 * Each invocation migrates the shared test database. vitest.config.mts warns
 * about exactly that, and the warning does not apply: its hazard was setting
 * the database up a second time WHILE the first project's workers were
 * querying it. Sequential processes have no such window - nothing is querying
 * anything when the second setup runs.
 *
 * ---------------------------------------------------------------------------
 * `!db` rather than a list of the others
 * ---------------------------------------------------------------------------
 *
 * The first group is stated as a negation on purpose. Naming core, worker,
 * web-server and web would mean a project added later belongs to no group and
 * is silently never run - which is precisely the failure this whole file
 * exists to catch, reintroduced by the fix for something else. Written as
 * "everything that is not db", a new project joins the first group by default
 * and the worst case is that it runs in the wrong one.
 */
const GROUPS = [
  { label: "everything except db", project: "!db" },
  { label: "db", project: "db" },
];

const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * vitest.mjs directly rather than through npx. Node 24 refuses to spawn a .cmd
 * without a shell, so `npx.cmd` fails outright on Windows, and going through a
 * shell to work around that would mean quoting the report path by hand.
 *
 * Spawning without a shell also means `!db` is passed through literally. Under
 * a shell it would be history expansion on some and a glob negation on others.
 */
const vitest = path.resolve(here, "..", "node_modules", "vitest", "vitest.mjs");

const out = mkdtempSync(path.join(tmpdir(), "wa-os-test-"));

/** Collected tests per group, or null where the report was unreadable. */
const counts = [];
let failed = null;

try {
  for (const group of GROUPS) {
    const report = path.join(out, `report-${group.project.replace("!", "not-")}.json`);

    console.log(`\n=== vitest run --project=${group.project} (${group.label})\n`);

    /*
     * Both reporters: the default one so a human still sees the run, the json
     * one so this script can count. --outputFile.json is the per-reporter form
     * and is required once there is more than one reporter.
     */
    const result = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        `--project=${group.project}`,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      { stdio: "inherit" },
    );

    if (result.status !== 0 && failed === null) {
      failed = { group, status: result.status ?? 1 };
    }

    try {
      counts.push(JSON.parse(readFileSync(report, "utf8")).numTotalTests ?? null);
    } catch (cause) {
      console.error(
        `\nCould not read the ${group.label} report at ${report}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
      counts.push(null);
    }

    /*
     * Both groups run even when the first fails, which is what the single
     * invocation did: it reported every failure in the suite rather than the
     * first one. Stopping early would trade a slower red run for a less
     * informative one, and the extra cost is only ever paid on a failure.
     */
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failed !== null) {
  console.error(`\nTests failed (${failed.group.label}).`);
  process.exit(failed.status);
}

if (counts.some((count) => count === null)) {
  console.error(
    "\nThe suite passed but produced no readable report, so the test count " +
      "could not be checked. Treating that as a failure: an unreadable report " +
      "is the same evidence as a short one.",
  );
  process.exit(1);
}

/*
 * Summed across the groups, and compared once.
 *
 * A floor per group would be two numbers to maintain and would have to be
 * re-split by hand whenever a project moved between them. The question the
 * floor asks - did this run collect the tests this repository has - is about
 * the whole suite, and the whole suite is what the groups add up to.
 */
const total = counts.reduce((sum, count) => sum + count, 0);

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
      "The suite runs as two invocations - see GROUPS above - so a project",
      "belonging to neither group is also a way to get here. The first group",
      "is written as a negation so that cannot happen by omission.",
      "",
      "If tests were deliberately removed, lower MINIMUM_TESTS in",
      "scripts/test-floor.mjs in the same commit, and say why.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `\n${total} tests ran (floor ${MINIMUM_TESTS}) — ` +
    GROUPS.map((group, i) => `${group.label}: ${counts[i]}`).join(", ") +
    ".",
);
