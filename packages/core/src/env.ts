import { z } from "zod";

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

/** Variables both the web app and the worker need. */
export const sharedEnvSchema = z.object({
  NODE_ENV: nodeEnv,

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),

  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required")
    .refine(
      (value) =>
        value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a redis:// or rediss:// connection string",
    ),

  /** 32 raw bytes, base64-encoded. Generate: openssl rand -base64 32 */
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required")
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)",
    ),
});

/** Web-only additions. */
export const webEnvSchema = sharedEnvSchema.extend({
  APP_URL: z.url().default("http://localhost:3000"),
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
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");

    // eslint-disable-next-line no-console
    console.error(
      `\nInvalid ${label}:\n${issues}\n\n` +
        "Copy .env.example to .env and fill in the missing values.\n",
    );
    process.exit(1);
  }

  return result.data;
}
