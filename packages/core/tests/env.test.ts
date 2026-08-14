import { describe, expect, it } from "vitest";
import { safeParseEnv, sharedEnvSchema, workerEnvSchema } from "../src/env.ts";

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
