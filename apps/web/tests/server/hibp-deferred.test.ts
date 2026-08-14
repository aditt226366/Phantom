import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUpSchema } from "@whatsapp-os/core";
import { signIn } from "@/lib/auth/signin";
import { signUp } from "@/lib/auth/signup";
import { resolveSessionByToken } from "@/lib/auth/session-store";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The deferred breach check.
 *
 * Signup fails open when HaveIBeenPwned is unreachable. The next successful
 * sign-in is the only later moment the plaintext exists again — the stored
 * value is an Argon2id hash and HIBP is indexed by SHA-1 of the password — so
 * that is where the retry happens.
 */

const PASSWORD = "a-sufficiently-long-password";

const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });

afterAll(async () => {
  await raw.end();
});

async function truncateAll(): Promise<void> {
  const { rows } = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await raw.query(
    `TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/** A 200 with no matching suffix: checked, not breached. */
function hibpClean() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
}

/** A 200 whose body contains this password's own suffix: checked, breached. */
function hibpBreached(password = PASSWORD) {
  const suffix = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase()
    .slice(5);

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(`${suffix}:1200\n`, { status: 200 })),
  );
}

/** A timeout: not checked. */
function hibpDown() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }),
  );
}

function form() {
  return signUpSchema.parse({
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "ada@example.test",
    phone: "9876543210",
    username: "ada_l",
    password: PASSWORD,
    confirmPassword: PASSWORD,
  });
}

async function userState(): Promise<{
  hibp_checked_at: Date | null;
  password_breached_at: Date | null;
}> {
  const { rows } = await raw.query(
    "SELECT hibp_checked_at, password_breached_at FROM users",
  );
  return rows[0];
}

async function auditActions(): Promise<string[]> {
  const { rows } = await raw.query<{ action: string }>(
    "SELECT action FROM audit_log ORDER BY created_at, action",
  );
  return rows.map((r) => r.action);
}

beforeEach(async () => {
  await truncateAll();
});

describe("signup", () => {
  it("stamps hibpCheckedAt when the check ran", async () => {
    hibpClean();
    const result = await signUp(form(), {});
    expect(result.ok).toBe(true);

    const state = await userState();
    expect(state.hibp_checked_at).toBeInstanceOf(Date);
    expect(state.password_breached_at).toBeNull();
  });

  it("leaves it null when the check failed open", async () => {
    hibpDown();
    const result = await signUp(form(), {});
    expect(result.ok).toBe(true);

    /*
     * The whole mechanism rests on this. Stamping optimistically here would
     * close the gap on paper and leave the password unchecked forever.
     */
    const state = await userState();
    expect(state.hibp_checked_at).toBeNull();
    expect(await auditActions()).toContain("HIBP_UNAVAILABLE");
  });
});

describe("the next sign-in", () => {
  beforeEach(async () => {
    hibpDown();
    const result = await signUp(form(), {});
    if (!result.ok) throw new Error("signup failed");
    expect((await userState()).hibp_checked_at).toBeNull();
  });

  it("fills it in when the check now succeeds", async () => {
    hibpClean();

    const result = await signIn(
      { username: "ada_l", password: PASSWORD },
      { ip: "203.0.113.1" },
    );
    expect(result.ok).toBe(true);

    const state = await userState();
    expect(state.hibp_checked_at).toBeInstanceOf(Date);
    expect(state.password_breached_at).toBeNull();
    expect(await auditActions()).toContain("HIBP_CHECKED");
  });

  it("does not run again once it has succeeded", async () => {
    hibpClean();
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.1" });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.1" });

    /* One sign-in per affected user, not one per sign-in forever. */
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags the password without blocking the sign-in when breached", async () => {
    hibpBreached();

    const result = await signIn(
      { username: "ada_l", password: PASSWORD },
      { ip: "203.0.113.1" },
    );

    /*
     * Advisory, not a block. Refusing the session would lock someone out of an
     * account they just proved they can authenticate to, and leave them no
     * route to fix it.
     */
    expect(result.ok).toBe(true);

    const state = await userState();
    expect(state.hibp_checked_at).toBeInstanceOf(Date);
    expect(state.password_breached_at).toBeInstanceOf(Date);
    expect(await auditActions()).toContain("PASSWORD_BREACHED");
  });

  it("surfaces the flag on the session", async () => {
    hibpBreached();
    const result = await signIn(
      { username: "ada_l", password: PASSWORD },
      { ip: "203.0.113.1" },
    );
    if (!result.ok) throw new Error("sign-in failed");

    /* The shell reads this to render the banner. */
    const session = await resolveSessionByToken(result.value.sessionToken);
    expect(session?.user.passwordBreachedAt).toBeInstanceOf(Date);
  });

  it("leaves the state untouched when HIBP is still down", async () => {
    hibpDown();

    const result = await signIn(
      { username: "ada_l", password: PASSWORD },
      { ip: "203.0.113.1" },
    );
    expect(result.ok).toBe(true);

    /*
     * Not "checked". Recording success after a failed lookup would mark the
     * control as having run when it had not, and the retry would never fire
     * again — the same silent gap, moved one step later and made permanent.
     */
    const state = await userState();
    expect(state.hibp_checked_at).toBeNull();
    expect(state.password_breached_at).toBeNull();
    expect(await auditActions()).toContain("HIBP_UNAVAILABLE");
  });

  it("retries on the sign-in after that", async () => {
    hibpDown();
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.1" });
    expect((await userState()).hibp_checked_at).toBeNull();

    hibpClean();
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.1" });

    expect((await userState()).hibp_checked_at).toBeInstanceOf(Date);
  });
});

describe("a failed sign-in", () => {
  it("never sends the guess to HaveIBeenPwned", async () => {
    hibpDown();
    const result = await signUp(form(), {});
    if (!result.ok) throw new Error("signup failed");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await signIn(
      { username: "ada_l", password: "the-wrong-password-here" },
      { ip: "203.0.113.2" },
    );

    /*
     * The check runs only after the password is verified. Otherwise every
     * failed attempt would ship an attacker-supplied hash to a third party and
     * burn the shared quota.
     */
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await userState()).hibp_checked_at).toBeNull();
  });

  it("never runs for an unknown username", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await signIn(
      { username: "nobody_here", password: PASSWORD },
      { ip: "203.0.113.3" },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
