import { z } from "zod";
import { parseKeyMaterial } from "./encryption.ts";
import { err, ok, type Result } from "./types.ts";

/**
 * Environment contract.
 *
 * Every variable the system reads is declared here once, with a Zod schema.
 * Nothing in the codebase should touch process.env directly - import the
 * parsed object instead, so a missing or malformed variable fails loudly at
 * boot rather than as `undefined` three layers deep at request time.
 *
 * Keep this in sync with .env.example at the repo root.
 */

const nodeEnv = z
  .enum(["development", "test", "production"])
  .default("development");

const postgresUrl = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      `${name} must be a postgres:// or postgresql:// connection string`,
    );

/** Variables both the web app and the worker need. */
export const sharedEnvSchema = z.object({
  NODE_ENV: nodeEnv,

  /**
   * whatsapp_owner. Migrations and the Prisma CLI only.
   *
   * NOSUPERUSER, NOBYPASSRLS, CREATEDB. It owns the tables, and FORCE ROW
   * LEVEL SECURITY means even it sees nothing without a company context.
   * Application code must still never connect with it — it can turn FORCE off.
   *
   * The cluster superuser lives in POSTGRES_SUPERUSER_URL and is deliberately
   * absent from this schema: only `npm run db:roles` needs it, and a
   * production app should not be able to read a superuser credential at all.
   */
  DATABASE_URL: postgresUrl("DATABASE_URL"),

  /**
   * The runtime role (app_runtime). Every application query goes through this.
   *
   * It owns nothing, so RLS policies actually apply to it. There is
   * deliberately no fallback to DATABASE_URL — see packages/db/src/client.ts.
   */
  DATABASE_URL_APP: postgresUrl("DATABASE_URL_APP"),

  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required")
    .refine(
      (value) =>
        value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a redis:// or rediss:// connection string",
    ),

  /**
   * 32 raw bytes, base64-encoded. Generate: openssl rand -base64 32
   *
   * Not part of the vault keyring, and not interchangeable with it. This is the
   * HMAC key that hashIp() uses in session-store.ts and admin-session.ts, so
   * changing it invalidates every stored ip_hash rather than anything
   * decryptable. It stays required independently of ENCRYPTION_KEYS.
   */
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required")
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)",
    ),

  /**
   * The vault keyring: `id:base64key,id:base64key`.
   *
   * Several at once, because rotation needs the old key to still open old rows
   * while the new one seals new ones. Validated with the same parser the
   * encryption module uses, rather than a second regex that agrees with it
   * until it does not.
   *
   * Single-quote this in .env: Docker Compose reads the same file, and base64
   * is fine but the habit is what keeps an Argon2 hash two lines down from
   * being expanded.
   */
  ENCRYPTION_KEYS: z
    .string()
    .min(1, "ENCRYPTION_KEYS is required")
    .refine(
      (value) => {
        try {
          parseKeyMaterial(value);
          return true;
        } catch {
          return false;
        }
      },
      "ENCRYPTION_KEYS must be id:base64key pairs, comma-separated, each key " +
        "decoding to 32 bytes and each id matching [a-z0-9_]{1,16}",
    ),

  /**
   * Which key seals new writes.
   *
   * That it names a key actually present in ENCRYPTION_KEYS is checked by
   * createKeyring(), not here: an object-level refinement would make this
   * schema unextendable, and both webEnvSchema and workerEnvSchema extend it.
   */
  ENCRYPTION_KEY_ACTIVE: z
    .string()
    .min(1, "ENCRYPTION_KEY_ACTIVE is required")
    .regex(
      /^[a-z0-9_]{1,16}$/,
      "ENCRYPTION_KEY_ACTIVE must match [a-z0-9_]{1,16}",
    ),
});

/** Web-only additions. */
export const webEnvSchema = sharedEnvSchema.extend({
  APP_URL: z.url().default("http://localhost:3000"),

  /**
   * The platform-admin role (app_admin), which can read across companies.
   *
   * Optional: only the admin route group needs it, and the app boots without
   * an admin panel. Used by exactly one module, packages/db/src/admin-client.ts.
   */
  DATABASE_URL_ADMIN: postgresUrl("DATABASE_URL_ADMIN").optional(),
});

/** Worker-only additions. */
export const workerEnvSchema = sharedEnvSchema.extend({
  /** How many jobs a single worker process handles at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(200).default(5),
  /** Queue prefix, so several environments can share one Redis instance. */
  QUEUE_PREFIX: z.string().min(1).default("whatsapp-os"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Parse a schema against a source, returning a Result instead of exiting.
 *
 * This is the non-fatal half of parseEnv, extracted so tests can exercise the
 * contract without `process.exit(1)` taking the test runner down with it.
 * Application code should keep using parseEnv - failing to boot on bad
 * configuration is the correct default.
 */
export function safeParseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown> = process.env,
  label = "environment",
): Result<z.infer<T>, string> {
  const result = schema.safeParse(source);

  if (result.success) {
    return ok(result.data);
  }

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");

  return err(`Invalid ${label}:\n${issues}`);
}

/**
 * Parse a schema against process.env (or any source), printing a readable
 * report and exiting non-zero on failure.
 *
 * A process that boots with bad configuration is worse than one that refuses
 * to boot, so this is deliberately fatal rather than throwing something a
 * caller might swallow.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown> = process.env,
  label = "environment",
): z.infer<T> {
  const parsed = safeParseEnv(schema, source, label);

  if (!parsed.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `\n${parsed.error}\n\n` +
        "Copy .env.example to .env and fill in the missing values.\n",
    );
    process.exit(1);
  }

  return parsed.value;
}
