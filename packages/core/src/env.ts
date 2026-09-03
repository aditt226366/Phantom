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

/**
 * A credential that may simply not be set.
 *
 * `.optional()` alone accepts `undefined` and REFUSES an empty string - and an
 * empty string is exactly how an unset variable is written in a .env file:
 *
 *     VERSE_V1_API_KEY=
 *
 * Without this, `.env.example` fails its own contract test and a fresh clone
 * cannot boot, because four variables nobody has set are each "too small".
 * That is a boot failure for the absence of an optional feature, which is the
 * shape of guard that gets deleted rather than satisfied.
 *
 * So blank means absent, which is what a person writing that line meant.
 */
const optionalSecret = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
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

  /**
   * Makes the lead-source mapping screen read a literal instead of Google.
   *
   * Scaffolding, and the only piece of it in the application's environment. It
   * exists because that screen is the one page in the app that calls a provider
   * before it can render, so the screenshot suite - which has no network -
   * would otherwise spend the full ten-second provider timeout at two viewports
   * on every run and photograph an error state. The screen most worth looking
   * at would be the one screen never looked at.
   *
   * Set by apps/web/playwright.config.ts and by nothing else. It is declared
   * here rather than read straight from process.env so that the refinement
   * below can exist: a boot-time check beats a comment asking people not to.
   */
  LEAD_SHEET_FIXTURE: z.string().optional(),

  /**
   * The same hook, for the Meta Ads connect screen.
   *
   * That screen is the second page in this application that must call a
   * provider before it can render: it lists the ad accounts and Pages the
   * tenant's own token can reach, and there is no useful version of it that
   * does not. Without a fixture the gate spends two ten-second provider
   * timeouts per run photographing an error state, and the screen where a
   * tenant chooses which account will spend their money becomes the one screen
   * nobody ever looks at.
   *
   * A second variable rather than one shared flag, deliberately. They switch
   * different screens, and a single FIXTURES=1 would mean that turning one on
   * for a local look silently turned the other on too.
   */
  META_ADS_FIXTURE: z.string().optional(),

  /* The same four keys, read by /dev/rag so the harness can call a model.
     Optional for the reason the worker's are - see verseKeys below. */
  VERSE_V1_API_KEY: optionalSecret,
  VERSE_V2_API_KEY: optionalSecret,
  VERSE_V3_API_KEY: optionalSecret,
  VERSE_EMBEDDING_API_KEY: optionalSecret,
}).superRefine((env, ctx) => {
  /**
   * The fixture must never be live.
   *
   * An environment variable is inherited far more easily than anyone plans: a
   * copied .env, a shared compose file, a CI runner promoted to a deploy, a
   * container image built from a developer's shell. The failure that would
   * produce is quiet and specific - a real tenant's mapping screen showing
   * Anita Desai and Vikram Shah, and that tenant mapping their columns against
   * five rows of a fixture rather than their own spreadsheet.
   *
   * Nothing downstream would notice. The mapping saved from a fictional preview
   * is structurally valid, the poll reads the real sheet with it, and the first
   * symptom is messages filled from the wrong columns.
   *
   * ---------------------------------------------------------------------------
   * Why NODE_ENV alone is the wrong test, discovered by writing it
   * ---------------------------------------------------------------------------
   *
   * The obvious condition is "refuse when NODE_ENV is production", and it
   * refuses the screenshot suite: `next start` IS production mode, and that
   * suite is the only legitimate consumer of this variable. Shipping that
   * version would have meant the fixture could never be used at all.
   *
   * So the second half is the database. An application serving `whatsapp_os_test`
   * is not serving tenants - there are none in it, the fixture truncates it on
   * every run, and `db-nuke.mjs` already treats that name as the marker of a
   * database that may be destroyed. A production deploy points at a production
   * database by definition, so an inherited variable there still refuses.
   *
   * Both halves are needed. NODE_ENV alone blocks the suite; the database alone
   * would permit a developer's production-mode build against a test database,
   * which is fine, and would also permit nothing worth worrying about - the
   * pairing is what makes the refusal precise rather than merely strict.
   *
   * It fails to boot rather than warning. parseEnv exits non-zero, so in
   * production the deploy does not come up: loud, immediate and attributable,
   * which is the opposite of every property the silent version has.
   */
  const fixtures = [
    ["LEAD_SHEET_FIXTURE", env.LEAD_SHEET_FIXTURE],
    ["META_ADS_FIXTURE", env.META_ADS_FIXTURE],
  ] as const;

  const set = fixtures.filter(([, value]) => value !== undefined);
  if (set.length === 0) return;
  if (env.NODE_ENV !== "production") return;

  /* The test database, by name. Parsing the URL rather than matching a
     substring, so a production database that merely CONTAINS the string -
     `whatsapp_os_testing`, a user called `whatsapp_os_test` - does not let the
     fixture through. */
  let servingTestDatabase = false;
  try {
    const name = new URL(env.DATABASE_URL_APP).pathname.replace(/^\//, "");
    servingTestDatabase = name === "whatsapp_os_test";
  } catch {
    servingTestDatabase = false;
  }

  if (servingTestDatabase) return;

  /* Reported per variable rather than as one message naming both, so a deploy
     that inherited one of them is told which one. */
  const WHY: Record<string, string> = {
    LEAD_SHEET_FIXTURE:
      "It makes the lead-source mapping screen read a fixture instead of the " +
      "tenant's real spreadsheet, so a mapping saved from it would be filled " +
      "from the wrong columns.",
    META_ADS_FIXTURE:
      "It makes the Meta Ads connect screen list fictional ad accounts and " +
      "Pages instead of the tenant's own, so an account selected from it names " +
      "something that does not exist and no spend would ever arrive.",
  };

  for (const [name] of set) {
    ctx.addIssue({
      code: "custom",
      path: [name],
      message:
        `${name} must not be set in production. ${WHY[name] ?? ""} It is set by ` +
        "apps/web/playwright.config.ts and by nothing else - unset it.",
    });
  }
});

/**
 * The Verse model keys, on the worker only.
 *
 * ---------------------------------------------------------------------------
 * Optional, and that is the whole of the "fail loudly" design
 * ---------------------------------------------------------------------------
 *
 * A required key here would refuse to boot a worker that has plenty of other
 * jobs to run - webhooks, sends, media, rollups - because one feature nobody
 * has switched on yet has no credential. That is a guard which gets deleted
 * rather than satisfied.
 *
 * So they are optional and the failure moves to the point of use, where it can
 * say something specific: an ingestion FAILS the document with a sentence
 * naming the variable, and `npm run verse:metric` exits non-zero naming every
 * one that is missing. Neither of those is a skip, and neither prints a pass.
 *
 * Platform-level rather than per-tenant, deliberately - no tenant has an
 * Anthropic or an OpenAI account, and the point of the Verse naming is that
 * they never learn which model answered. Cost is attributed per tenant through
 * usage_events instead.
 */
const verseKeys = {
  VERSE_V1_API_KEY: optionalSecret,
  VERSE_V2_API_KEY: optionalSecret,
  VERSE_V3_API_KEY: optionalSecret,
  VERSE_EMBEDDING_API_KEY: optionalSecret,
};

/** Worker-only additions. */
export const workerEnvSchema = sharedEnvSchema.extend({
  ...verseKeys,
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
