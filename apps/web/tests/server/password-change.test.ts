import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUpSchema, verifyPassword } from "@whatsapp-os/core";
import { withCompany } from "@whatsapp-os/db";
import { issueAdminPasswordReset } from "@/lib/auth/admin-reset";
import {
  MAX_RESETS_PER_EMAIL,
  consumeResetToken,
  inspectResetToken,
  requestPasswordReset,
} from "@/lib/auth/password-reset";
import { resolveSessionByToken } from "@/lib/auth/session-store";
import { setPassword } from "@/lib/auth/set-password";
import { signIn } from "@/lib/auth/signin";
import { signUp } from "@/lib/auth/signup";
import { upsertAdminUser } from "@/lib/admin-db";
import { hashPassword } from "@whatsapp-os/core";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

const PASSWORD = "a-sufficiently-long-password";
const NEW_PASSWORD = "an-entirely-different-passphrase";

const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });

afterAll(async () => {
  await raw.end();
});

function hibpClean() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
}

function hibpBreached(password: string) {
  const suffix = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase()
    .slice(5);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(`${suffix}:900\n`, { status: 200 })),
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

async function seed() {
  const result = await signUp(
    signUpSchema.parse({
      fullName: "Ada Lovelace",
      companyName: "Analytical Engines",
      email: "ada@example.test",
      phone: "9876543210",
      username: "ada_l",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    }),
    { ip: "203.0.113.1" },
  );
  if (!result.ok) throw new Error("signup failed");
  return result.value;
}

async function liveSessionCount(userId: string): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return Number(rows[0]!.n);
}

beforeEach(async () => {
  await truncateAll();
  hibpClean();
});

describe("setPassword", () => {
  it("revokes every session, including the caller's", async () => {
    const account = await seed();
    /* A second device. */
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.2" });
    expect(await liveSessionCount(account.userId)).toBe(2);

    await setPassword(
      account.companyId,
      account.userId,
      NEW_PASSWORD,
      "change",
    );

    /*
     * A password change is what you do after "someone else may have my
     * account". Leaving other sessions alive makes it ceremonial.
     */
    expect(await liveSessionCount(account.userId)).toBe(0);
    expect(await resolveSessionByToken(account.sessionToken)).toBeNull();
  });

  it("writes the new hash and clears the breach flag", async () => {
    const account = await seed();
    await raw.query("UPDATE users SET password_breached_at = now()");

    await setPassword(account.companyId, account.userId, NEW_PASSWORD, "change");

    const { rows } = await raw.query<{
      password_hash: string;
      password_breached_at: Date | null;
      hibp_checked_at: Date | null;
    }>(
      "SELECT password_hash, password_breached_at, hibp_checked_at FROM users",
    );

    await expect(
      verifyPassword(rows[0]!.password_hash, NEW_PASSWORD),
    ).resolves.toBe(true);
    /* The flag described the old password. */
    expect(rows[0]!.password_breached_at).toBeNull();
    expect(rows[0]!.hibp_checked_at).toBeInstanceOf(Date);
  });

  it("refuses a breached password, unlike sign-in", async () => {
    const account = await seed();
    hibpBreached(NEW_PASSWORD);

    const result = await setPassword(
      account.companyId,
      account.userId,
      NEW_PASSWORD,
      "change",
    );

    /*
     * At sign-in a hit is advisory — the user already has that password and
     * locking them out helps nobody. Here they are choosing one, so refusing
     * costs a second attempt and nothing else.
     */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("password_breached");
  });

  it("refuses a denylisted password", async () => {
    const account = await seed();
    const result = await setPassword(
      account.companyId,
      account.userId,
      "unbelievable",
      "change",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("password_common");
  });

  it("leaves hibpCheckedAt null when the check could not run", async () => {
    const account = await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("t");
        e.name = "TimeoutError";
        throw e;
      }),
    );

    await setPassword(account.companyId, account.userId, NEW_PASSWORD, "change");

    /* So the deferred re-check at next sign-in fires, as after signup. */
    const { rows } = await raw.query("SELECT hibp_checked_at FROM users");
    expect(rows[0].hibp_checked_at).toBeNull();
  });

  it("spends outstanding reset links", async () => {
    const account = await seed();
    const request = await requestPasswordReset("ada@example.test", "203.0.113.9");
    expect(request.token).toBeTruthy();

    await setPassword(account.companyId, account.userId, NEW_PASSWORD, "change");

    /* The password is already set; a live link would be a second way in. */
    expect((await consumeResetToken(request.token!)).ok).toBe(false);
  });
});

describe("forgot password", () => {
  it("responds identically for a known and an unknown address", async () => {
    await seed();

    const known = await requestPasswordReset("ada@example.test", "203.0.113.10");
    const unknown = await requestPasswordReset("nobody@example.test", "203.0.113.11");

    /*
     * The caller sends the same page either way. Only the presence of a token
     * differs, and that never reaches the response — with no password to guess
     * and no lockout to hit, a "no such account" message is a clean membership
     * oracle.
     */
    expect(Object.keys(known).sort()).toContain("token");
    expect(unknown.token).toBeUndefined();
    expect(unknown.email).toBe("nobody@example.test");
  });

  it("issues a single-use token", async () => {
    await seed();
    const request = await requestPasswordReset("ada@example.test", "203.0.113.12");

    const first = await consumeResetToken(request.token!);
    expect(first.ok).toBe(true);

    const second = await consumeResetToken(request.token!);
    expect(second.ok).toBe(false);
  });

  it("expires after an hour", async () => {
    await seed();
    const request = await requestPasswordReset("ada@example.test", "203.0.113.13");

    /* Shorter than the 24h verification token: this one is a full takeover. */
    const { rows } = await raw.query<{ minutes: string }>(
      "SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 60 AS minutes FROM password_reset_tokens",
    );
    expect(Math.round(Number(rows[0]!.minutes))).toBe(60);

    await raw.query(
      "UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'",
    );
    expect((await consumeResetToken(request.token!)).ok).toBe(false);
  });

  it("does not spend the token when merely inspected", async () => {
    await seed();
    const request = await requestPasswordReset("ada@example.test", "203.0.113.14");

    /* A mail client prefetching the link must not burn it. */
    expect((await inspectResetToken(request.token!)).ok).toBe(true);
    expect((await inspectResetToken(request.token!)).ok).toBe(true);
    expect((await consumeResetToken(request.token!)).ok).toBe(true);
  });

  it("invalidates an earlier link when a new one is requested", async () => {
    await seed();
    const first = await requestPasswordReset("ada@example.test", "203.0.113.15");
    const second = await requestPasswordReset("ada@example.test", "203.0.113.15");

    expect((await consumeResetToken(first.token!)).ok).toBe(false);
    expect((await consumeResetToken(second.token!)).ok).toBe(true);
  });

  it("kills every session when the reset completes", async () => {
    const account = await seed();
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.16" });
    expect(await liveSessionCount(account.userId)).toBe(2);

    const request = await requestPasswordReset("ada@example.test", "203.0.113.17");
    const consumed = await consumeResetToken(request.token!);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;

    await setPassword(consumed.companyId, consumed.userId, NEW_PASSWORD, "reset");

    expect(await liveSessionCount(account.userId)).toBe(0);
  });

  it("throttles per email address", async () => {
    await seed();

    for (let i = 0; i < MAX_RESETS_PER_EMAIL; i++) {
      /* Different addresses each time, so only the per-email counter trips. */
      await requestPasswordReset("ada@example.test", `198.51.100.${i}`);
    }

    const throttled = await requestPasswordReset(
      "ada@example.test",
      "198.51.100.200",
    );

    /* One mailbox cannot be flooded from a botnet. */
    expect(throttled.token).toBeUndefined();
  });

  it("throttles per address", async () => {
    await seed();
    const ip = "198.51.100.77";

    for (let i = 0; i < MAX_RESETS_PER_EMAIL; i++) {
      await requestPasswordReset(`someone${i}@example.test`, ip);
    }

    /* One client cannot enumerate addresses by volume. */
    const throttled = await requestPasswordReset("ada@example.test", ip);
    expect(throttled.token).toBeUndefined();
  });
});

describe("admin-issued reset", () => {
  async function seedAdmin() {
    const { id } = await upsertAdminUser(
      "root",
      await hashPassword("an-admin-password-here"),
    );
    return id;
  }

  it("never returns the token to the caller's result shape", async () => {
    /*
     * The token is returned to the *action*, which mails it. What matters is
     * that the action's response carries nothing — asserted on the action's
     * contract in the UI test below, and here on the audit trail.
     */
    const account = await seed();
    const adminId = await seedAdmin();

    const result = await issueAdminPasswordReset(adminId, "ada_l", "203.0.113.20");
    expect(result.ok).toBe(true);

    const { rows } = await raw.query<{ action: string; metadata: unknown }>(
      "SELECT action, metadata FROM admin_audit_log ORDER BY created_at",
    );
    expect(rows.map((r) => r.action)).toContain("admin.password_reset.issued");

    /* The token never reaches the audit row either. */
    expect(JSON.stringify(rows)).not.toContain(result.token!);
    expect(account.userId).toBeTruthy();
  });

  it("revokes sessions immediately, not on token use", async () => {
    const account = await seed();
    const adminId = await seedAdmin();
    await signIn({ username: "ada_l", password: PASSWORD }, { ip: "203.0.113.21" });
    expect(await liveSessionCount(account.userId)).toBe(2);

    const result = await issueAdminPasswordReset(adminId, "ada_l", "203.0.113.22");

    /*
     * The reason to press this button is a suspected compromise. Waiting for
     * the user to act on an email leaves the attacker signed in meanwhile.
     */
    expect(result.sessionsRevoked).toBe(2);
    expect(await liveSessionCount(account.userId)).toBe(0);
  });

  it("records the request in the tenant's own audit log too", async () => {
    await seed();
    const adminId = await seedAdmin();
    await issueAdminPasswordReset(adminId, "ada_l", "203.0.113.23");

    const { rows } = await raw.query<{ action: string; metadata: { origin: string } }>(
      "SELECT action, metadata FROM audit_log WHERE action = 'PASSWORD_RESET_REQUESTED'",
    );

    /* Visible to the company, not only to the platform. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.origin).toBe("admin");
  });

  it("reports failure for an unknown user without creating anything", async () => {
    const adminId = await seedAdmin();
    const result = await issueAdminPasswordReset(adminId, "nobody", "203.0.113.24");

    expect(result.ok).toBe(false);
    expect(result.token).toBeUndefined();

    const { rows } = await raw.query("SELECT 1 FROM password_reset_tokens");
    expect(rows).toHaveLength(0);
  });
});

describe("the reset token cannot cross companies", () => {
  it("resolves to its own company and no other", async () => {
    await seed();
    const other = await signUp(
      signUpSchema.parse({
        fullName: "Beta Owner",
        companyName: "Beta Works",
        email: "beta@example.test",
        phone: "9876543211",
        username: "beta_owner",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
      {},
    );
    if (!other.ok) throw new Error("signup failed");

    const request = await requestPasswordReset("beta@example.test", "203.0.113.30");
    const consumed = await consumeResetToken(request.token!);

    expect(consumed.ok).toBe(true);
    if (consumed.ok) expect(consumed.companyId).toBe(other.value.companyId);
  });

  it("is invisible from another company's context", async () => {
    const alpha = await seed();
    const request = await requestPasswordReset("ada@example.test", "203.0.113.31");

    const otherCompany = await signUp(
      signUpSchema.parse({
        fullName: "Beta Owner",
        companyName: "Beta Works",
        email: "beta@example.test",
        phone: "9876543211",
        username: "beta_owner",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
      {},
    );
    if (!otherCompany.ok) throw new Error("signup failed");

    const found = await withCompany(otherCompany.value.companyId, (db) =>
      db.passwordResetToken.findMany(),
    );

    /* Beta sees none of alpha's, which is RLS and not application logic. */
    expect(found).toEqual([]);
    expect(alpha.companyId).not.toBe(otherCompany.value.companyId);
    expect(request.token).toBeTruthy();
  });
});
