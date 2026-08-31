/**
 * A test worker must never be allowed to leave quietly.
 *
 * `process.exit()` inside a Vitest fork is reported as
 *
 *     Error: [vitest-pool]: Worker forks emitted error.
 *     Caused by: Error: Worker exited unexpectedly
 *
 * with a non-zero run and no stack, no file name, and no indication of which
 * module made the call. The tests that had not started yet are absences rather
 * than failures, so the count comes up short and the reason is nowhere.
 *
 * `parseEnv` in @whatsapp-os/core does exactly this on a validation failure -
 * deliberately, because an application that boots with bad configuration is
 * worse than one that refuses to boot. `safeParseEnv` is the non-fatal half and
 * exists precisely so tests can exercise the contract without taking the runner
 * down. Anything that reaches the fatal one from a test, at module scope or
 * otherwise, dies this way.
 *
 * So: replace it with a throw. A fatal exit becomes a named failure attributed
 * to the file that caused it, which is the difference between "a worker
 * vanished" and "this module called process.exit(1)".
 *
 * The stack is also written to stderr before throwing. If anything swallows the
 * error - a catch-all in a setup file, a floating promise - the evidence still
 * survives, which is the whole point of installing this rather than trusting
 * the throw to arrive somewhere useful.
 *
 * Permanent, whatever it does or does not catch today. This converts a class of
 * invisible death into a located one, and the cost is nothing on a run where
 * nobody calls it.
 */

const realExit = process.exit.bind(process);

/** Escape hatch, for the one test that needs to assert this guard exists. */
export function exitForReal(code: number): never {
  return realExit(code);
}

/*
 * The other way a worker dies without saying anything.
 *
 * An unhandled rejection terminates the process in Node 15+, and from the pool
 * side that is indistinguishable from an exit: "Worker exited unexpectedly",
 * no stack. A pg client whose connection is dropped mid-query - which is what
 * a concurrent ALTER ROLE against the shared test database can produce - fails
 * exactly this way.
 *
 * Logged, not swallowed. Vitest has its own reporting for these and suppressing
 * them would trade one silence for another; the point is only that the stack
 * reaches stderr before the process goes.
 */
for (const signal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(signal, (reason: unknown) => {
    const stack =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`\n${signal} in a test worker:\n${stack}\n`);
  });
}

process.exit = ((code?: number | string | null): never => {
  const requested = typeof code === "number" ? code : Number(code ?? 0);
  const error = new Error(
    `process.exit(${requested}) was called inside a test worker. ` +
      `A test must fail, not exit - see tests/no-silent-exit.ts.`,
  );
  error.name = "SilentExitError";

  /* Before throwing, so a swallowed error still leaves evidence. */
  process.stderr.write(`\n${error.name}: ${error.message}\n${error.stack ?? ""}\n`);

  throw error;
}) as typeof process.exit;
