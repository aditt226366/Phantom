/**
 * Enough environment for the worker's modules to import.
 *
 * apps/worker/src/env.ts calls parseEnv, which process.exit(1)s on a missing
 * variable — that would take the test runner down rather than fail a test. Set
 * before anything imports it, which setupFiles guarantees.
 *
 * `??=` throughout: a developer's real .env is loaded by loadRootEnv and is
 * perfectly good, but CI has no .env at all and these tests do not need a real
 * database or Redis to exercise a logger.
 */

process.env["NODE_ENV"] ??= "test";
process.env["DATABASE_URL"] ??=
  "postgresql://whatsapp_owner:pw@localhost:5432/whatsapp_os_test";
process.env["DATABASE_URL_APP"] ??=
  "postgresql://app_runtime:pw@localhost:5432/whatsapp_os_test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["ENCRYPTION_KEY"] ??= Buffer.alloc(32).toString("base64");
process.env["ENCRYPTION_KEYS"] ??= `k1:${Buffer.alloc(32, 1).toString("base64")}`;
process.env["ENCRYPTION_KEY_ACTIVE"] ??= "k1";

/* The logger reads this once, at module load, to fix its threshold. */
process.env["LOG_LEVEL"] ??= "debug";
