import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate's retry fires for a dead vitest process and never for a real
 * failure — and the two files that decide that cannot drift apart.
 *
 * ---------------------------------------------------------------------------
 * The hinge, and the two times it moved
 * ---------------------------------------------------------------------------
 *
 * `.githooks/pre-commit` decides whether a red gate was the known crash by
 * grepping the log. `scripts/test-floor.mjs` writes the log. The trigger lives
 * in one file and the text it triggers on lives in another, which is a hinge,
 * and it has now swung twice:
 *
 *   once  the hook knew only "Worker exited unexpectedly" and met the other
 *         presentation - the whole process dying with no report at all. Caught
 *         because it refused a commit with 63 files reported and nothing
 *         failing, and fixed by adding the sentence test-floor.mjs printed.
 *
 *   twice the suite was split into two invocations, and that sentence gained
 *         the name of the half that died: "Could not read the EVERYTHING
 *         EXCEPT DB report at". The string the hook looked for no longer
 *         existed anywhere. The retry was dead from 9a6917a onwards and
 *         NOTHING WENT RED, because nothing was watching this seam.
 *
 * The second one is the reason this file exists. A guard that is switched off
 * by a commit with no reason to think it is touching a guard will stay off
 * until it is needed, and the moment it is needed is the worst moment to
 * discover it. So the hook now matches a marker rather than a sentence, and
 * this test reads the hook's own patterns and runs them over the exact bytes
 * `gate-signals.mjs` produces.
 *
 * ---------------------------------------------------------------------------
 * What this does and does not check
 * ---------------------------------------------------------------------------
 *
 * It reads the PATTERNS out of the shell function; it does not run the shell
 * function. `sh` and `grep` are not on PATH on the machine this repository is
 * developed on - only WSL's bash - so shelling out would either skip on the
 * developer's own machine or depend on WSL being up, and a check that skips is
 * a check that stops guarding without saying so.
 *
 * The boolean STRUCTURE of the function - "any positive signature, and no test
 * actually failed" - is therefore restated in `isCrashShaped` below rather than
 * read from the file. That is a deliberate and narrow duplication: the
 * structure has never moved in the life of this hook, and the strings have
 * moved twice. If the structure ever does change, this test is stale rather
 * than wrong, and the assertions on the pattern LIST will not notice - which is
 * the known limit of this file and is why the counts are asserted too.
 *
 * ---------------------------------------------------------------------------
 * This test's own output can contain the marker, and that is safe
 * ---------------------------------------------------------------------------
 *
 * The strings built below contain the very token the hook greps for, so a
 * failure here prints it into the gate's log. That cannot cause a false retry:
 * a failure here also prints "Tests N failed", and the hook's second condition
 * refuses a retry whenever anything failed. The guard that stops a real failure
 * getting a second roll of the dice is the same one that stops this file
 * poisoning the log.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const hookSource = readFileSync(join(repoRoot, ".githooks", "pre-commit"), "utf8");

/*
 * Imported through a computed path on purpose.
 *
 * `gate-signals.mjs` is plain JavaScript outside every workspace, and this
 * repository's tsconfig has `allowJs` off - a static import of it would not
 * typecheck. A dynamic import of a non-literal specifier is typed `any` by
 * tsc, so the cast below is where the shape is stated, once.
 */
const signals = (await import(
  pathToFileURL(join(repoRoot, "scripts", "gate-signals.mjs")).href
)) as {
  REPORT_UNREADABLE_SIGNAL: string;
  reportUnreadableMessage: (label: string, reportPath: string, cause: string) => string;
};

type Matcher = { pattern: string; extended: boolean; negated: boolean };

/** The body of `is_crash_shaped`, from its opening line to its closing brace. */
function crashMatcherBody(): string {
  const start = hookSource.indexOf("is_crash_shaped() {");
  expect(start, "`is_crash_shaped` is not in .githooks/pre-commit any more").toBeGreaterThan(-1);

  const end = hookSource.indexOf("\n}", start);
  expect(end, "`is_crash_shaped` has no closing brace on its own line").toBeGreaterThan(start);

  return hookSource.slice(start, end);
}

/**
 * Every `grep` the matcher runs, with the two things that change its meaning:
 * whether it is negated, and whether it is an extended regex.
 */
function matchers(): Matcher[] {
  const found: Matcher[] = [];

  for (const match of crashMatcherBody().matchAll(/(!\s*)?grep\s+-q(E?)\s+"([^"]*)"/g)) {
    const pattern = match[3];
    if (pattern === undefined) continue;
    found.push({ pattern, extended: match[2] === "E", negated: match[1] !== undefined });
  }

  return found;
}

/**
 * `grep` is line-oriented and so is `m`, which is why the flag is here.
 *
 * A basic-regex `grep` - no `-E` - is asserted to be a plain literal rather
 * than translated. `+`, `?`, `{`, `}`, `(`, `)` and `|` are LITERAL characters
 * in BRE and metacharacters in JavaScript, so a BRE carrying one would be
 * evaluated here as something the hook does not mean. Refusing to translate is
 * both simpler and honest: the assertion says "the hook's plain greps must
 * stay plain", which is true of both of them and worth keeping true.
 */
function toRegExp(matcher: Matcher): RegExp {
  if (!matcher.extended) {
    expect(
      matcher.pattern,
      `this grep has no -E, so ${JSON.stringify(matcher.pattern)} is a BASIC regex; ` +
        "a metacharacter in it means something different here than it does in the hook",
    ).not.toMatch(/[\\^$.|?*+()[\]{}]/);
  }

  return new RegExp(matcher.pattern, "m");
}

/** The hook's decision, restated. See the header for why this half is not read. */
function isCrashShaped(log: string): boolean {
  const all = matchers();
  const positive = all.filter((m) => !m.negated).some((m) => toRegExp(m).test(log));
  const negative = all.filter((m) => m.negated).some((m) => toRegExp(m).test(log));
  return positive && !negative;
}

/** A gate log for a run where every test passed. */
const HEALTHY_LOG = [
  "=== vitest run --project=!db (everything except db)",
  " ✓ |core| tests/verse-router.test.ts (26 tests) 226ms",
  " Test Files  99 passed (99)",
  "      Tests  1408 passed | 2 skipped (1410)",
  "1917 tests ran (floor 886) — everything except db: 1408, db: 509.",
].join("\n");

/** The same run, with one assertion genuinely broken. */
const REAL_FAILURE_LOG = [
  "=== vitest run --project=!db (everything except db)",
  " × |core| tests/verse-score.test.ts > scores a reply > refuses an off-topic turn",
  " Test Files  1 failed | 98 passed (99)",
  "      Tests  3 failed | 1405 passed (1408)",
].join("\n");

describe("the gate's crash matcher", () => {
  it("reads its patterns out of the hook rather than restating them", () => {
    /*
     * The guard that stops every assertion below being vacuously true. A
     * parser that finds nothing makes "no pattern misbehaves" trivially pass,
     * which is the shape of failure this whole file is about.
     */
    const all = matchers();
    const positive = all.filter((m) => !m.negated);
    const negative = all.filter((m) => m.negated);

    expect(positive.length, "the hook should test at least two crash signatures").toBeGreaterThanOrEqual(2);
    expect(
      negative.length,
      "exactly one negated grep - the one that refuses a retry when a test actually failed",
    ).toBe(1);
  });

  it("recognises a vitest process that died before writing its report", () => {
    /*
     * Every label the gate can print, INCLUDING one that does not exist yet.
     *
     * The marker carries no label precisely so that a third group added to
     * GROUPS in test-floor.mjs trips the hook with no edit in either file.
     * That is the property the third case here is asserting, and it is the one
     * that would have prevented the last regression.
     */
    for (const label of ["everything except db", "db", "a group added in some later phase"]) {
      const log = [
        " ✓ |web-server| tests/server/company-deactivation.test.ts (15 tests) 5121ms",
        signals.reportUnreadableMessage(
          label,
          "/tmp/wa-os-test-IC9fps/report-not-db.json",
          "ENOENT: no such file or directory",
        ),
        `Tests failed (${label}).`,
      ].join("\n");

      expect(
        isCrashShaped(log),
        `the hook does not recognise a dead process for the "${label}" group; ` +
          "its greps and scripts/gate-signals.mjs have drifted apart",
      ).toBe(true);
    }
  });

  it("recognises the other presentation, a worker dying inside a surviving run", () => {
    /*
     * This signature is vitest's own text, not ours, so it cannot be bound to
     * a marker the way the other one is - there is nothing on our side of it
     * to define. It is asserted here anyway so that dropping it from the hook
     * is a failing test rather than a silent halving of the retry.
     */
    const log = [
      " ✓ |db| tests/verse-ordering.test.ts (3 tests) 674ms",
      "Error: [vitest-pool]: Worker forks emitted error",
      "Caused by: Error: Worker exited unexpectedly",
      " Test Files  43 passed (43)",
    ].join("\n");

    expect(isCrashShaped(log), "the hook no longer recognises a dead fork").toBe(true);
  });

  it("does not fire on a gate that simply passed", () => {
    expect(isCrashShaped(HEALTHY_LOG)).toBe(false);
  });

  it("refuses a retry when a test actually failed", () => {
    expect(isCrashShaped(REAL_FAILURE_LOG)).toBe(false);
  });

  it("refuses a retry when a test failed AND the process died", () => {
    /*
     * The case the second condition exists for, and the one that must never be
     * relaxed: a run where something genuinely broke does not get another roll
     * of the dice merely because a process also died. Asserted separately from
     * the plain failure above because only this one has both signals present.
     */
    const log = [
      REAL_FAILURE_LOG,
      signals.reportUnreadableMessage(
        "db",
        "/tmp/wa-os-test-IC9fps/report-db.json",
        "ENOENT: no such file or directory",
      ),
    ].join("\n");

    expect(isCrashShaped(log), "a real failure was handed a retry").toBe(false);
  });
});

describe("the message the matcher matches", () => {
  it("is printed by test-floor.mjs through the one module that defines it", () => {
    /*
     * The source half of the pair. The assertions above prove the hook's
     * patterns match what `reportUnreadableMessage` returns; this proves the
     * script actually calls it, which no amount of matching strings can show.
     *
     * Comments are stripped first. test-floor.mjs explains this exact hinge in
     * prose, so a check that read the raw file would be satisfied by the
     * explanation of the bug rather than by the fix for it - which is the
     * failure this repository has now hit four times.
     */
    const raw = readFileSync(join(repoRoot, "scripts", "test-floor.mjs"), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code, "test-floor.mjs no longer imports the shared signal module").toContain(
      'from "./gate-signals.mjs"',
    );
    expect(
      code,
      "test-floor.mjs imports the module but never calls it, so nothing prints the marker",
    ).toContain("reportUnreadableMessage(");
  });

  it("carries the marker on a line of its own, whatever the prose beside it says", () => {
    /*
     * `grep` is line-oriented. A marker sharing a line with an interpolated
     * path would still match today, but it would start depending on the prose
     * again the first time somebody wraps the message - which is the entire
     * failure being fixed here.
     */
    const message = signals.reportUnreadableMessage("db", "/tmp/r.json", "ENOENT");

    expect(message.split("\n")).toContain(signals.REPORT_UNREADABLE_SIGNAL);
  });
});
