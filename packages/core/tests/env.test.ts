import { describe, expect, it } from "vitest";
import {
  safeParseEnv,
  sharedEnvSchema,
  webEnvSchema,
  workerEnvSchema,
} from "../src/env.ts";

/**
 * These exercise safeParseEnv rather than parseEnv on purpose: parseEnv calls
 * process.exit(1) on failure, which would take the test runner down with it.
 */

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://owner:pw@localhost:5432/db",
  DATABASE_URL_APP: "postgresql://app_runtime:pw@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString("base64")}`,
  ENCRYPTION_KEY_ACTIVE: "k1",
};

describe("safeParseEnv", () => {
  it("accepts a complete environment", () => {
    const result = safeParseEnv(sharedEnvSchema, valid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.NODE_ENV).toBe("test");
    }
  });

  it("reports the offending key rather than throwing", () => {
    const result = safeParseEnv(sharedEnvSchema, {
      ...valid,
      DATABASE_URL: "mysql://user:pw@localhost:3306/db",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("DATABASE_URL");
    }
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    const result = safeParseEnv(sharedEnvSchema, {
      ...valid,
      ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("32 bytes");
    }
  });

  it("rejects a keyring entry that is not 32 bytes", () => {
    const result = safeParseEnv(sharedEnvSchema, {
      ...valid,
      ENCRYPTION_KEYS: `k1:${Buffer.alloc(16).toString("base64")}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENCRYPTION_KEYS");
    }
  });

  it("rejects a malformed active key id", () => {
    const result = safeParseEnv(sharedEnvSchema, {
      ...valid,
      ENCRYPTION_KEY_ACTIVE: "Key One",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENCRYPTION_KEY_ACTIVE");
    }
  });

  it("still requires ENCRYPTION_KEY alongside the keyring", () => {
    /*
     * The two are unrelated and both mandatory. ENCRYPTION_KEY is the HMAC key
     * for hashIp(); dropping it because "the keyring replaced it" would
     * invalidate every stored ip_hash and nothing would say so.
     */
    const { ENCRYPTION_KEY: _dropped, ...withoutIt } = valid;
    const result = safeParseEnv(sharedEnvSchema, withoutIt);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENCRYPTION_KEY");
    }
  });

  it("requires the runtime connection string separately", () => {
    const { DATABASE_URL_APP: _omitted, ...withoutApp } = valid;

    const result = safeParseEnv(sharedEnvSchema, withoutApp);

    /*
     * DATABASE_URL_APP is not optional and does not fall back to DATABASE_URL.
     * The owner role is exempt from its own tables' RLS policies, so falling
     * back would silently disable tenant isolation.
     */
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("DATABASE_URL_APP");
    }
  });

  it("applies declared defaults", () => {
    const result = safeParseEnv(workerEnvSchema, valid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.WORKER_CONCURRENCY).toBe(5);
      expect(result.value.QUEUE_PREFIX).toBe("whatsapp-os");
    }
  });
});

describe("the lead-source fixture flag", () => {
  /**
   * Scaffolding in the application's environment earns a check rather than a
   * comment asking people not to.
   *
   * The failure it prevents is quiet and specific: an inherited variable - a
   * copied .env, a shared compose file, a CI runner promoted to a deploy - and
   * a real tenant's mapping screen showing Anita Desai and Vikram Shah. They
   * map their columns against five rows of a fixture, the mapping is
   * structurally valid, the poll reads their real sheet with it, and the first
   * symptom is messages filled from the wrong columns.
   */
  const PROD_DB = "postgresql://app_runtime:pw@db.internal:5432/whatsapp_os";
  const TEST_DB = "postgresql://app_runtime:pw@localhost:45500/whatsapp_os_test";
  const FIXTURE = "northwind-visual-fixture";

  /* The file's own fixture, promoted to production. Building a second one by
     hand is how a test ends up asserting against an environment that was
     invalid for an unrelated reason. */
  const base = { ...valid, NODE_ENV: "production" };

  it("refuses a production deploy that has it set", () => {
    const result = safeParseEnv(
      webEnvSchema,
      { ...base, DATABASE_URL_APP: PROD_DB, LEAD_SHEET_FIXTURE: FIXTURE },
      "web environment",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    /* Names the variable, because "invalid web environment" on a deploy that
       will not come up is a sentence nobody can act on. */
    expect(result.error).toContain("LEAD_SHEET_FIXTURE");
  });

  it("refuses any value, not only the sentinel", () => {
    /* The guard is about the variable existing in production at all. A value
       the code does not recognise is still a variable that should not be
       there, and treating it as harmless is how the next sentinel gets added
       without anyone revisiting this. */
    const result = safeParseEnv(
      webEnvSchema,
      { ...base, DATABASE_URL_APP: PROD_DB, LEAD_SHEET_FIXTURE: "anything" },
      "web environment",
    );

    expect(result.ok).toBe(false);
  });

  it("allows the screenshot suite, which runs in production mode", () => {
    /*
     * The case that made NODE_ENV alone the wrong test. `next start` IS
     * production mode, and that suite is the only legitimate consumer of this
     * variable - a guard on NODE_ENV alone means the fixture can never be used
     * at all, which is how a check gets deleted rather than fixed.
     */
    const result = safeParseEnv(
      webEnvSchema,
      { ...base, DATABASE_URL_APP: TEST_DB, LEAD_SHEET_FIXTURE: FIXTURE },
      "web environment",
    );

    expect(result.ok ? "" : result.error).toBe("");
  });

  it("is not fooled by a production database whose name merely contains the test one", () => {
    /* `whatsapp_os_testing` is a production database. A substring match would
       hand it the fixture. */
    const result = safeParseEnv(
      webEnvSchema,
      {
        ...base,
        DATABASE_URL_APP: "postgresql://app_runtime:pw@db.internal:5432/whatsapp_os_testing",
        LEAD_SHEET_FIXTURE: FIXTURE,
      },
      "web environment",
    );

    expect(result.ok).toBe(false);
  });

  it("allows it outside production entirely", () => {
    const result = safeParseEnv(
      webEnvSchema,
      { ...valid, NODE_ENV: "test", LEAD_SHEET_FIXTURE: FIXTURE },
      "web environment",
    );

    expect(result.ok).toBe(true);
  });

  it("boots production perfectly well when it is absent", () => {
    /* The guard must not have made the ordinary case fail - a refusal that
       fires on every deploy is one somebody removes. */
    const result = safeParseEnv(
      webEnvSchema,
      { ...base, DATABASE_URL_APP: PROD_DB },
      "web environment",
    );

    expect(result.ok ? "" : result.error).toBe("");
  });
});
