import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Apply a deliberate break, prove it broke something, and put the file back.
 *
 * Break-once is the discipline that a new assertion must be seen to fail before
 * it is trusted. Doing it by hand needs a copy of the file to restore from, and
 * that copy is where it goes wrong: this repository has lost an afternoon twice
 * to a break whose cleanup never ran, because the test worker died mid-run and
 * a `finally` does not execute in a killed process.
 *
 *   1. a probe added email_verification_tokens.forced_failure and left it,
 *      which no migration, schema file or drift check could see
 *   2. a probe disabled the media size cap in an UNTRACKED file, and the
 *      scratchpad backup taken "before" it captured the damage too - so diff
 *      reported clean against a broken baseline and there was nothing true
 *      left to compare against
 *
 * The fork crash that kills these runs is not being investigated, by agreement.
 * So the mitigation cannot be care: it has to be that every break is
 * recoverable from git by construction, whatever kills the process.
 *
 * That is what this script is. git is the baseline:
 *
 *   git add <file>          stages your work - the thing to restore TO, which
 *                           is not HEAD and not a copy somewhere else
 *   substitute              the break, asserted to have matched exactly once
 *   git diff -- <file>      shows precisely what the break changed
 *   <command>               must FAIL, or the break proved nothing
 *   git checkout -- <file>  restores from the index, i.e. your work back
 *
 * A killed run then leaves the break sitting in `git status` and `git diff`,
 * where it is obvious, instead of in a file nobody is comparing.
 *
 * Usage:
 *
 *   node scripts/break-once.mjs \
 *     --file packages/core/src/whatsapp/media.ts \
 *     --find 'if (received > MAX_MEDIA_BYTES) {' \
 *     --replace 'if (received > MAX_MEDIA_BYTES * 100) {' \
 *     --command 'npx vitest run --project core packages/core/tests/whatsapp-media.test.ts'
 *
 * \n in --find and --replace is expanded, for multi-line anchors.
 */

function fail(message) {
  console.error(`\nbreak-once: ${message}\n`);
  process.exit(1);
}

function git(args, options = {}) {
  return spawnSync("git", args, { encoding: "utf8", ...options });
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`could not read arguments at "${key ?? ""}". See the header of this file.`);
    }
    parsed[key.slice(2)] = value.replaceAll("\n", "\n");
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

for (const required of ["file", "find", "replace", "command"]) {
  /* Presence, not truthiness: `--replace ''` is a legitimate break - deleting a
     guard is often the cleanest way to remove it - and a falsy check refused
     it. */
  if (args[required] === undefined) fail(`--${required} is required.`);
}

const { file, find, replace, command } = args;

/*
 * The refusal that matters, and the reason this is a script rather than a
 * paragraph. An untracked file has no baseline: `git diff` shows nothing
 * because git is not watching it, and `git checkout --` has nothing to restore.
 * A break applied to one is unrecoverable the moment the process dies, which is
 * exactly what happened to media.ts.
 */
if (git(["ls-files", "--error-unmatch", file]).status !== 0) {
  fail(
    `${file} is not tracked by git.\n\n` +
      "  A break needs a baseline that survives the process being killed, and an\n" +
      "  untracked file has none - git diff sees nothing and git checkout has\n" +
      "  nothing to restore. This is not a formality: a break lost in an untracked\n" +
      "  file corrupted the source AND the backup taken beside it.\n\n" +
      `  git add ${file}   (then re-run, or commit it first)`,
  );
}

/*
 * A pipeline reports the exit status of its LAST command, so `vitest ... | tail`
 * is `tail`, which succeeds essentially always. This script decides whether the
 * break was observed entirely from that status - so through a pipe it cannot
 * observe anything, and would report a failing suite as a passing one.
 *
 * Not hypothetical, and not a beginner's mistake: piping `npm run verify` to
 * `tail` swallowed a red gate three times in this repository before anybody
 * noticed, which is why the pre-commit hook exists. It caught this script out
 * too, on its own first run.
 */
const pipeless = command.replaceAll("||", "");
if (pipeless.includes("|")) {
  fail(
    [
      "--command contains a pipe, and a pipeline's exit status is its LAST",
      "  command's - so the failure this break is supposed to cause would be",
      "  invisible here and reported as a pass.",
      "",
      "  Redirect instead, and read the file afterwards:",
      "",
      "    --command '<cmd> > /tmp/break.log 2>&1'",
    ].join("\n"),
  );
}

const original = readFileSync(file, "utf8");
const occurrences = original.split(find).length - 1;

if (occurrences === 0) {
  /*
   * The failure break-once exists to catch, in the tool that performs it. Two
   * of three breaks in one Phase 4a commit reported no failures because the
   * substitution never matched - so nothing had changed, and the suite was
   * green because the code was still correct.
   */
  fail(`--find matched nothing in ${file}. The break did not land.`);
}

if (occurrences > 1) {
  fail(
    `--find matched ${occurrences} places in ${file}. Narrow it, or the break ` +
      "changes more than it claims.",
  );
}

/* Stage the current work. This, not HEAD, is what the restore returns to. */
if (git(["add", "--", file]).status !== 0) {
  fail(`could not stage ${file}.`);
}

/*
 * The baseline run, and it is not optional.
 *
 * Without it this script decides the break was observed from a single fact -
 * the command exited non-zero - and a command can exit non-zero for reasons
 * that have nothing to do with the break. Not hypothetical: it once reported
 * "the command failed with the break applied, as it should have" when the
 * command had failed because Postgres was down and vitest never ran a test at
 * all. A false pass, from the tool whose whole job is to prevent them.
 *
 * A mistyped test path does the same thing - "No test files found" exits 1 and
 * is indistinguishable from a break being caught.
 *
 * So the command must PASS before the break, or the run afterwards is not
 * attributable to it. This doubles the wall clock, and that is the price of
 * the result meaning what it says.
 */
console.log(`\nbreak-once: baseline (before the break) - ${command}\n`);
const baseline = spawnSync(command, { shell: true, stdio: "inherit" });

if (baseline.status !== 0) {
  fail(
    [
      `the command FAILED before the break was applied (exit ${baseline.status}).`,
      "",
      "  Nothing that happens after this would be attributable to the break, so",
      "  the run is refused rather than reported. Usual causes, in order:",
      "",
      "    the environment is down       npm run services:up",
      "    the filter matches no tests   check the path in --command",
      "    something is already failing  fix that first",
    ].join("\n"),
  );
}

writeFileSync(file, original.replace(find, replace));

console.log(`\nbreak-once: applied to ${file}\n`);
const diff = git(["diff", "--", file]).stdout;
console.log(diff.trim() || "(git reported no change - the break did nothing)");

console.log(`\nbreak-once: running ${command}\n`);
const run = spawnSync(command, { shell: true, stdio: "inherit" });

/* Restore before interpreting anything, so a thrown assertion cannot skip it. */
const restored = git(["checkout", "--", file]);
const residue = git(["diff", "--", file]).stdout;

if (restored.status !== 0 || residue.trim() !== "") {
  fail(
    `${file} was NOT restored. Fix it before doing anything else:\n\n` +
      `  git checkout -- ${file}`,
  );
}

console.log(`\nbreak-once: ${file} restored, working tree clean.\n`);

if (run.status === 0) {
  /*
   * The whole point. A command that still passes with the code broken is a
   * command that was not testing the thing that was broken - which is a finding
   * about the test, not a success.
   */
  fail(
    "the command PASSED with the break applied.\n\n" +
      "  Nothing observed the break, so the assertion it was meant to prove does\n" +
      "  not cover this code. Either the test is weak, or the break is provably\n" +
      "  unobservable - and that second case belongs in a comment, recorded, not\n" +
      "  quietly accepted.",
  );
}

console.log(
  `break-once: the command passed clean, then failed with the break applied.\n`,
);
