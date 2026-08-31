/**
 * Exit codes migrate-test.mjs uses to tell its caller *why* setup failed.
 *
 * One constant in one place, because the two ends are in different languages
 * and different processes: the script exits with it, and the Vitest globalSetup
 * that spawned the script reads it to decide which instruction to print. A
 * literal in both files would drift, and the failure mode of that drift is a
 * misleading instruction on a failure nobody has seen before - which is exactly
 * what this exists to prevent.
 */

/**
 * The test database holds something no migration created.
 *
 * Distinct from a generic non-zero exit because the remedy is entirely
 * different: "Postgres is not running" and "rebuild the database" are not
 * interchangeable advice, and the second one arrives when somebody is already
 * confused about a suite that was green an hour ago.
 */
export const EXIT_SCHEMA_DRIFT = 3;
