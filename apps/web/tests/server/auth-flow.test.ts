import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken, signUpSchema } from "@whatsapp-os/core";
import { withCompany } from "@whatsapp-os/db";
import {
  MAX_FAILURES_PER_IP,
  lockoutDurationMs,
  MAX_SIGNUPS_PER_IP,
  checkSignupAllowed,
  recordSignupAttempt,
} from "@/lib/auth/lockout";
import { signIn } from "@/lib/auth/signin";
import { signUp } from "@/lib/auth/signup";
import {
  consumeVerificationToken,
  reissueVerificationToken,
} from "@/lib/auth/verify-email";
import { resolveSessionByToken } from "@/lib/auth/session-store";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Sign-up and sign-in end to end, against a real database.
 *
 * fetch is stubbed throughout: the HaveIBeenPwned check must not make the test
 * suite depend on a third-party service, and the fail-open branch has to be
 * reachable without waiting three real seconds.
 */

const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });

afterAll(async () => {
  await raw.end();
});

/** A 200 with no matching suffix: "checked, not breached". */
function mockHibpClean() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
}

async function truncateAll(): Promise<void> {
  const { rows } = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await raw.query(
    `TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

function form(overrides: Record<string, string> = {}) {
  return signUpSchema.parse({
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "ada@example.test",
    phone: "9876543210",
    username: "ada_l",
    password: "a-sufficiently-long-password",
    confirmPassword: "a-sufficiently-long-password",
    ...overrides,
  });
}

beforeEach(async () => {
  await truncateAll();
  mockHibpClean();
});

describe("signing up", () => {
  it("creates the company, owner, token and session in one go", async () => {
    const result = await signUp(form(), { ip: "203.0.113.1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const counts = await raw.query<{ t: string; n: string }>(`
      SELECT 'companies' AS t, count(*)::text AS n FROM companies
      UNION ALL SELECT 'users', count(*)::text FROM users
      UNION ALL SELECT 'sessions', count(*)::text FROM sessions
      UNION ALL SELECT 'tokens', count(*)::text FROM email_verification_tokens
      UNION ALL SELECT 'audit', count(*)::text FROM audit_log
    `);

    const byTable = Object.fromEntries(counts.rows.map((r) => [r.t, r.n]));
    expect(byTable).toMatchObject({
      companies: "1",
      users: "1",
      sessions: "1",
      tokens: "1",
      audit: "1",
    });

    /* The session is usable immediately — it was created in the same
       transaction, not a second one that could have failed. */
    const session = await resolveSessionByToken(result.value.sessionToken);
    expect(session?.companyId).toBe(result.value.companyId);
    expect(session?.user.username).toBe("ada_l");
  });

  it("makes the owner an OWNER with an unverified email", async () => {
    const result = await signUp(form(), {});
    expect(result.ok).toBe(true);

    const { rows } = await raw.query<{ role: string; verified: Date | null }>(
      "SELECT role, email_verified_at AS verified FROM users",
    );
    expect(rows[0]?.role).toBe("OWNER");
    expect(rows[0]?.verified).toBeNull();
  });

  it("rolls back completely when the transaction fails part way", async () => {
    /*
     * The atomicity claim, tested rather than asserted. A NOT NULL violation on
     * the verification token aborts the transaction after the company and user
     * rows have been inserted; if any of them survived, signup would leave an
     * account behind that nobody could finish creating.
     */
    await raw.query(
      `ALTER TABLE email_verification_tokens
         ADD COLUMN forced_failure text NOT NULL DEFAULT ''`,
    );
    await raw.query(
      `ALTER TABLE email_verification_tokens ALTER COLUMN forced_failure DROP DEFAULT`,
    );

    await expect(signUp(form(), {})).rejects.toThrow();

    const { rows } = await raw.query<{ companies: string; users: string }>(
      `SELECT (SELECT count(*) FROM companies)::text AS companies,
              (SELECT count(*) FROM users)::text AS users`,
    );
    expect(rows[0]).toEqual({ companies: "0", users: "0" });

    await raw.query(
      `ALTER TABLE email_verification_tokens DROP COLUMN forced_failure`,
    );
  });

  it("rejects a duplicate username", async () => {
    await signUp(form(), {});

    const second = await signUp(
      form({ username: "ada_l", email: "other@example.test" }),
      {},
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.reason).toBe("username_taken");
  });

  it("rejects a duplicate email", async () => {
    await signUp(form(), {});

    const second = await signUp(
      form({ username: "someone_else", email: "ada@example.test" }),
      {},
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.reason).toBe("email_taken");
  });

  it("gives two companies with the same name distinct slugs", async () => {
    /*
     * "That company name is taken" would be untrue and would disclose another
     * tenant. Both signups succeed; only the derived slug differs.
     */
    const first = await signUp(form(), {});
    const second = await signUp(
      form({ username: "second_user", email: "second@example.test" }),
      {},
    );

    expect(first.ok && second.ok).toBe(true);

    const { rows } = await raw.query<{ slug: string; name: string }>(
      "SELECT slug, name FROM companies ORDER BY created_at",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe(rows[1]?.name);
    expect(rows[0]?.slug).not.toBe(rows[1]?.slug);
  });

  it("refuses a denylisted password without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    /*
     * "unbelievable" is one of only ten entries in the 10k list that clear the
     * 12-character minimum — the length rule already excludes the rest before
     * this check runs. See the note in denylist.ts.
     */
    const result = await signUp(
      form({ password: "unbelievable", confirmPassword: "unbelievable" }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("password_common");

    /* The denylist runs first precisely so the common case needs no third party. */
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a breached password", async () => {
    const password = "a-sufficiently-long-password";
    const { createHash } = await import("node:crypto");
    const suffix = createHash("sha1")
      .update(password, "utf8")
      .digest("hex")
      .toUpperCase()
      .slice(5);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`${suffix}:9\n`, { status: 200 })),
    );

    const result = await signUp(form(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("password_breached");
  });

  it("proceeds and records an audit row when HIBP is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    const result = await signUp(form(), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.breachCheckSkipped).toBe(true);

    /* Failing open is only defensible if the gap is visible afterwards. */
    const { rows } = await raw.query<{ action: string }>(
      "SELECT action FROM audit_log ORDER BY action",
    );
    expect(rows.map((r) => r.action)).toContain("HIBP_UNAVAILABLE");
  });

  it("throttles signups per address", async () => {
    const ip = "198.51.100.20";

    for (let i = 0; i < MAX_SIGNUPS_PER_IP; i++) {
      expect((await checkSignupAllowed(ip)).locked).toBe(false);
      await recordSignupAttempt(ip);
    }

    /* Unthrottled signup means unlimited companies and a burned HIBP quota. */
    expect((await checkSignupAllowed(ip)).locked).toBe(true);
  });
});

describe("signing in", () => {
  const ip = "203.0.113.55";

  beforeEach(async () => {
    await signUp(form(), {});
  });

  it("accepts the right password", async () => {
    const result = await signIn(
      { username: "ada_l", password: "a-sufficiently-long-password" },
      { ip },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = await resolveSessionByToken(result.value.sessionToken);
    expect(session?.userId).toBe(result.value.userId);

    const { rows } = await raw.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'LOGIN'",
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects the wrong password", async () => {
    const result = await signIn(
      { username: "ada_l", password: "not-the-right-password" },
      { ip },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("invalid_credentials");
  });

  it("records an audit row for a failure on a KNOWN username", async () => {
    await signIn({ username: "ada_l", password: "wrong-password-here" }, { ip });

    const { rows } = await raw.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'LOGIN_FAILED'",
    );
    expect(rows).toHaveLength(1);
  });

  it("records an unknown username only in login_attempts", async () => {
    /*
     * audit_log is company-scoped with company_id NOT NULL, and an unknown
     * username has no company to attach a row to. login_attempts is global for
     * exactly this reason.
     */
    await signIn({ username: "ghost_user", password: "whatever-goes-here" }, { ip });

    const audit = await raw.query(
      "SELECT 1 FROM audit_log WHERE action = 'LOGIN_FAILED'",
    );
    expect(audit.rows).toHaveLength(0);

    const attempts = await raw.query<{ failure_count: number }>(
      "SELECT failure_count FROM login_attempts WHERE username = 'ghost_user' AND ip = $1",
      [ip],
    );
    expect(attempts.rows[0]?.failure_count).toBe(1);
  });
});

describe("lockout", () => {
  const ip = "203.0.113.77";

  beforeEach(async () => {
    await signUp(form(), {});
  });

  it("allows five attempts and refuses the sixth", async () => {
    /*
     * Stated precisely so this cannot be read two ways: attempts 1-5 each come
     * back "invalid_credentials"; attempt 6 comes back "locked".
     */
    for (let attempt = 1; attempt <= MAX_FAILURES_PER_IP; attempt++) {
      const result = await signIn(
        { username: "ada_l", password: "wrong-password-here" },
        { ip },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason, `attempt ${attempt}`).toBe(
          "invalid_credentials",
        );
      }
    }

    const sixth = await signIn(
      { username: "ada_l", password: "wrong-password-here" },
      { ip },
    );
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.error.reason).toBe("locked");
  });

  it("refuses the correct password while locked", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await signIn({ username: "ada_l", password: "wrong-password-here" }, { ip });
    }

    const result = await signIn(
      { username: "ada_l", password: "a-sufficiently-long-password" },
      { ip },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("locked");
  });

  it("locks for 15 minutes first, then escalates", () => {
    expect(lockoutDurationMs(1)).toBe(15 * 60 * 1_000);
    expect(lockoutDurationMs(2)).toBe(30 * 60 * 1_000);
    expect(lockoutDurationMs(3)).toBe(60 * 60 * 1_000);
    /* Capped, so a long-running attack cannot lock an account out for years. */
    expect(lockoutDurationMs(99)).toBe(24 * 60 * 60 * 1_000);
  });

  it("escalates the lock on the second lockout", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await signIn({ username: "ada_l", password: "wrong-password-here" }, { ip });
    }

    const first = await raw.query<{ locked_until: Date; lockout_count: number }>(
      "SELECT locked_until, lockout_count FROM login_attempts WHERE username='ada_l' AND ip=$1",
      [ip],
    );
    expect(first.rows[0]?.lockout_count).toBe(1);

    /* Expire the lock, then fail five more times. */
    await raw.query(
      "UPDATE login_attempts SET locked_until = now() - interval '1 minute' WHERE ip = $1",
      [ip],
    );
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await signIn({ username: "ada_l", password: "wrong-password-here" }, { ip });
    }

    const second = await raw.query<{ lockout_count: number }>(
      "SELECT lockout_count FROM login_attempts WHERE username='ada_l' AND ip=$1",
      [ip],
    );
    expect(second.rows[0]?.lockout_count).toBe(2);
  });

  it("resets failureCount on success but keeps lockoutCount", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await signIn({ username: "ada_l", password: "wrong-password-here" }, { ip });
    }
    await raw.query(
      "UPDATE login_attempts SET locked_until = now() - interval '1 minute' WHERE ip = $1",
      [ip],
    );

    await signIn(
      { username: "ada_l", password: "a-sufficiently-long-password" },
      { ip },
    );

    const { rows } = await raw.query<{
      failure_count: number;
      lockout_count: number;
    }>(
      "SELECT failure_count, lockout_count FROM login_attempts WHERE username='ada_l' AND ip=$1",
      [ip],
    );

    expect(rows[0]?.failure_count).toBe(0);
    /* Getting in once must not hand back a fresh 15-minute budget. */
    expect(rows[0]?.lockout_count).toBe(1);
  });

  it("locks an unknown username the same way as a real one", async () => {
    /*
     * The enumeration hole that gets missed. If only real accounts ever lock,
     * six attempts tells an attacker whether an account exists — which undoes
     * the matching response and the dummy-hash timing work in one step.
     */
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      const r = await signIn(
        { username: "ghost_user", password: "wrong-password-here" },
        { ip },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe("invalid_credentials");
    }

    const sixth = await signIn(
      { username: "ghost_user", password: "wrong-password-here" },
      { ip },
    );
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.error.reason).toBe("locked");
  });
});

describe("known and unknown usernames are indistinguishable", () => {
  const ip = "203.0.113.90";

  beforeEach(async () => {
    await signUp(form(), {});
  });

  it("returns the identical result shape", async () => {
    const known = await signIn(
      { username: "ada_l", password: "wrong-password-here" },
      { ip: "203.0.113.91" },
    );
    const unknown = await signIn(
      { username: "ghost_user", password: "wrong-password-here" },
      { ip: "203.0.113.92" },
    );

    expect(known).toEqual(unknown);
  });

  it("takes a comparable amount of time", async () => {
    /*
     * A wide band on purpose — this asserts the same order of magnitude, not a
     * stopwatch reading. What it catches is the dummy verification being
     * skipped, which changes the unknown path from ~100ms to microseconds.
     */
    const time = async (username: string, at: string) => {
      const start = performance.now();
      await signIn({ username, password: "wrong-password-here" }, { ip: at });
      return performance.now() - start;
    };

    const known = await time("ada_l", "203.0.113.93");
    const unknown = await time("ghost_user", "203.0.113.94");

    expect(unknown).toBeGreaterThan(known * 0.25);
    expect(unknown).toBeLessThan(known * 4);
  });
});

describe("email verification", () => {
  it("verifies once and only once", async () => {
    const result = await signUp(form(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = await consumeVerificationToken(result.value.verificationToken);
    expect(first.ok).toBe(true);

    const { rows } = await raw.query<{ verified: Date | null }>(
      "SELECT email_verified_at AS verified FROM users",
    );
    expect(rows[0]?.verified).not.toBeNull();

    /* Single use: the second click is indistinguishable from a bad token. */
    const second = await consumeVerificationToken(
      result.value.verificationToken,
    );
    expect(second.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const result = await signUp(form(), {});
    if (!result.ok) throw new Error("signup failed");

    await raw.query(
      "UPDATE email_verification_tokens SET expires_at = now() - interval '1 hour'",
    );

    expect(
      (await consumeVerificationToken(result.value.verificationToken)).ok,
    ).toBe(false);
  });

  it("rejects an unknown token", async () => {
    expect((await consumeVerificationToken("not-a-token")).ok).toBe(false);
    expect((await consumeVerificationToken("")).ok).toBe(false);
  });

  it("returns not_found for another company's token, never a 403", async () => {
    /*
     * Rule 3 in CLAUDE.md, enforced nowhere until now. From inside alpha's
     * context, beta's token is simply absent — there is no code path that can
     * report "this exists but is not yours".
     */
    const alpha = await signUp(form(), {});
    const beta = await signUp(
      form({
        username: "beta_owner",
        email: "beta@example.test",
        companyName: "Beta Works",
      }),
      {},
    );
    if (!alpha.ok || !beta.ok) throw new Error("signup failed");

    const found = await withCompany(alpha.value.companyId, (db) =>
      db.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(beta.value.verificationToken) },
      }),
    );
    expect(found).toBeNull();

    /* And consuming it resolves to beta, never to alpha. */
    const consumed = await consumeVerificationToken(
      beta.value.verificationToken,
    );
    expect(consumed.ok).toBe(true);
    if (consumed.ok) expect(consumed.companyId).toBe(beta.value.companyId);
  });

  it("invalidates the old link when a new one is issued", async () => {
    const result = await signUp(form(), {});
    if (!result.ok) throw new Error("signup failed");

    const fresh = await reissueVerificationToken(
      result.value.companyId,
      result.value.userId,
    );

    /* Otherwise every resend widens the window instead of moving it. */
    expect((await consumeVerificationToken(result.value.verificationToken)).ok).toBe(
      false,
    );
    expect((await consumeVerificationToken(fresh)).ok).toBe(true);
  });
});
