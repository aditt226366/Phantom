/**
 * The strings the pre-commit hook matches to tell a dead process from a real
 * failure — in one place, because they have already drifted apart once.
 *
 * ---------------------------------------------------------------------------
 * The hinge, and where it moved
 * ---------------------------------------------------------------------------
 *
 * The gate's retry exists for exactly one thing: a vitest process that dies
 * without failing a test. The hook decided a run was that shape by grepping
 * the sentence `test-floor.mjs` printed — "Could not read the test report at".
 *
 * Then the suite was split into two invocations, and the message gained the
 * name of the half that died: "Could not read the everything except db report
 * at". The sentence the hook was looking for no longer existed anywhere, so
 * the retry was dead from `9a6917a` onwards — a guard switched off by a commit
 * that had no reason to think it was touching one, with nothing anywhere that
 * would go red. It was noticed only when it refused a commit it should have
 * absorbed, one phase later.
 *
 * So what the hook matches is no longer a sentence. It is a MARKER: a token
 * with no job except being matched, which nothing else in the gate's output
 * produces, and which no rewording of the prose beside it can change. The
 * prose stays — a person reading the log still needs to know which half died
 * and where the report should have been — it is simply no longer load-bearing.
 *
 * `packages/core/tests/gate-crash-matcher.test.ts` reads the patterns out of
 * `.githooks/pre-commit` and runs them over the exact bytes the function below
 * produces, so the two files cannot drift apart again without a failing test.
 */

/**
 * Printed whenever a vitest invocation produces no readable JSON report.
 *
 * Deliberately carries no label. Which half died is diagnostic and belongs in
 * the sentence beside it; the signal answers one question — "did a vitest
 * process die without reporting?" — so a third group added to GROUPS later
 * trips it with no change here and no change in the hook.
 */
export const REPORT_UNREADABLE_SIGNAL = "GATE-SIGNAL: report-unreadable";

/**
 * The whole message: the marker on its own line, then what a person needs.
 *
 * One function rather than two statements at the call site, so the marker
 * cannot be printed without the explanation, nor the explanation without the
 * marker. The test asserts the hook matches THIS string, so anything that
 * reaches the log unmatched would have to leave here first.
 */
export function reportUnreadableMessage(label, reportPath, cause) {
  return (
    `\n${REPORT_UNREADABLE_SIGNAL}\n` +
    `Could not read the ${label} report at ${reportPath}: ${cause}`
  );
}
