import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "@whatsapp-os/core";
import { createCompany, newCompanyId, withCompany } from "@whatsapp-os/db";
import {
  CSRF_COOKIE_OPTIONS,
  EXPIRED_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/cookies";
import {
  createSessionRecord,
  resolveSessionByToken,
  revokeSessionByToken,
  sweepExpiredSessions,
} from "@/lib/auth/session-store";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Session lifecycle against a real database.
 *
 * The cookie layer in session.ts is a thin wrapper over these functions; it is
 * not tested here because `cookies()` only works inside a request. Everything
 * that can actually go wrong — tenant resolution, expiry, revocation, rolling
 * renewal — lives in session-store and is reachable from here.
 */

interface Seeded {
  companyId: string;
  userId: string;
  username: string;
}

/**
 * Test scaffolding connection, as a superuser.
 *
 * Deliberately not the owner. FORCE ROW LEVEL SECURITY subjects whatsapp_owner
 * to policies scoped TO app_runtime, so `SELECT * FROM sessions` as the owner
 * returns zero rows — the property proved in the RLS suite, which also makes
 * the owner useless for looking at what a test just wrote. A superuser bypasses
 * RLS unconditionally, which is right for a harness and wrong for everything
 * else.
 */
const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });

afterAll(async () => {
  await raw.end();
});

async function truncateAll(): Promise<void> {
  const { rows } = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await raw.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function seed(label: string): Promise<Seeded> {
  const companyId = newCompanyId();

  const userId = await withCompany(companyId, async (db, scoped) => {
    await createCompany(db, scoped, `${label} Ltd`);
    const user = await db.user.create({
      data: {
        companyId: scoped,
        fullName: `${label} Owner`,
        email: `owner@${label}.test`,
        username: `${label}_owner`,
        passwordHash: "$argon2id$placeholder",
        phoneE164: "+919876543210",
        role: "OWNER",
      },
    });
    return user.id;
  });

  return { companyId, userId, username: `${label}_owner` };
}

let alpha: Seeded;
let beta: Seeded;

beforeEach(async () => {
  await truncateAll();
  alpha = await seed("alpha");
  beta = await seed("beta");
});

describe("session cookie attributes", () => {
  /*
   * Asserted rather than eyeballed because every one of these is a security
   * property that fails silently. A missing HttpOnly is invisible until an XSS
   * turns into account takeover.
   */
  it("is HttpOnly, Secure, SameSite=Lax, Path=/ and 30 days", () => {
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe("lax");
    expect(SESSION_COOKIE_OPTIONS.path).toBe("/");
    expect(SESSION_COOKIE_OPTIONS.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("sets Secure unconditionally, not only in production", () => {
    /*
     * The `secure: NODE_ENV === "production"` idiom is the line that ships
     * wrong when NODE_ENV is unset in a container. NODE_ENV is "test" here, so
     * a conditional would evaluate false and this would fail.
     */
    expect(process.env["NODE_ENV"]).not.toBe("production");
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
    expect(CSRF_COOKIE_OPTIONS.secure).toBe(true);
  });

  it("clears with the same attributes it was set with", () => {
    /* A cookie deleted with different attributes is a different cookie, and
       the browser keeps the original. */
    expect(EXPIRED_COOKIE_OPTIONS.maxAge).toBe(0);
    expect(EXPIRED_COOKIE_OPTIONS.path).toBe(SESSION_COOKIE_OPTIONS.path);
    expect(EXPIRED_COOKIE_OPTIONS.sameSite).toBe(SESSION_COOKIE_OPTIONS.sameSite);
    expect(EXPIRED_COOKIE_OPTIONS.secure).toBe(SESSION_COOKIE_OPTIONS.secure);
    expect(EXPIRED_COOKIE_OPTIONS.httpOnly).toBe(SESSION_COOKIE_OPTIONS.httpOnly);
  });

  it("uses a __Host- prefixed name only in production", () => {
    expect(SESSION_COOKIE_NAME).toBe("wa_session");
  });
});

describe("resolving a session", () => {
  it("resolves to the right company and user", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);

    const session = await resolveSessionByToken(token);

    expect(session).not.toBeNull();
    expect(session?.companyId).toBe(alpha.companyId);
    expect(session?.userId).toBe(alpha.userId);
    expect(session?.user.username).toBe(alpha.username);
  });

  it("stores only the hash of the token", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);

    const { rows } = await raw.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashToken(token));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveSessionByToken("not-a-real-token")).toBeNull();
    expect(await resolveSessionByToken("")).toBeNull();
  });

  it("hashes the IP rather than storing it", async () => {
    await createSessionRecord(alpha.companyId, alpha.userId, {
      ip: "203.0.113.7",
    });

    const { rows } = await raw.query<{ ip_hash: string | null }>(
      "SELECT ip_hash FROM sessions",
    );

    expect(rows[0]?.ip_hash).toBeTruthy();
    expect(rows[0]?.ip_hash).not.toContain("203.0.113.7");
  });
});

describe("a session cannot reach another company", () => {
  it("does not resolve beta's session id under alpha's token", async () => {
    /*
     * The hand-edited cookie case. An attacker who learns another company's
     * session *id* gains nothing: the lookup is keyed on the hash of a token
     * they do not have, and the row is then read inside that company's own RLS
     * context.
     */
    const { token: alphaToken } = await createSessionRecord(
      alpha.companyId,
      alpha.userId,
    );
    await createSessionRecord(beta.companyId, beta.userId);

    const { rows } = await raw.query<{ id: string; company_id: string }>(
      "SELECT id, company_id FROM sessions WHERE company_id = $1",
      [beta.companyId],
    );
    const betaSessionId = rows[0]?.id;
    expect(betaSessionId).toBeTruthy();

    const resolved = await resolveSessionByToken(alphaToken);
    expect(resolved?.companyId).toBe(alpha.companyId);
    expect(resolved?.sessionId).not.toBe(betaSessionId);
  });

  it("cannot read beta's session row from inside alpha's context", async () => {
    const { token: betaToken } = await createSessionRecord(
      beta.companyId,
      beta.userId,
    );

    const found = await withCompany(alpha.companyId, (db) =>
      db.session.findUnique({ where: { tokenHash: hashToken(betaToken) } }),
    );

    /* null, not a 403 — it does not exist as far as alpha is concerned. */
    expect(found).toBeNull();
  });
});

describe("expiry and revocation", () => {
  it("rejects an expired session", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);

    await raw.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute'",
    );

    expect(await resolveSessionByToken(token)).toBeNull();
  });

  it("rejects a revoked session immediately", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);
    expect(await resolveSessionByToken(token)).not.toBeNull();

    await revokeSessionByToken(token);

    /* Server-side sessions exist so that logout is not advisory. */
    expect(await resolveSessionByToken(token)).toBeNull();
  });

  it("revoking one session leaves the others alone", async () => {
    const first = await createSessionRecord(alpha.companyId, alpha.userId);
    const second = await createSessionRecord(alpha.companyId, alpha.userId);

    await revokeSessionByToken(first.token);

    expect(await resolveSessionByToken(first.token)).toBeNull();
    expect(await resolveSessionByToken(second.token)).not.toBeNull();
  });

  it("sweeps expired sessions for a company", async () => {
    await createSessionRecord(alpha.companyId, alpha.userId);
    await createSessionRecord(alpha.companyId, alpha.userId);
    await raw.query(
      "UPDATE sessions SET expires_at = now() - interval '1 day' WHERE company_id = $1",
      [alpha.companyId],
    );
    const live = await createSessionRecord(alpha.companyId, alpha.userId);

    const removed = await sweepExpiredSessions(alpha.companyId);

    expect(removed).toBe(2);
    expect(await resolveSessionByToken(live.token)).not.toBeNull();
  });
});

describe("rolling renewal", () => {
  it("does not write on every request", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);

    const before = await raw.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM sessions",
    );

    await resolveSessionByToken(token);
    await resolveSessionByToken(token);

    const after = await raw.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM sessions",
    );

    /* A row write per page view turns every session into a contention point. */
    expect(after.rows[0]?.last_seen_at.getTime()).toBe(
      before.rows[0]?.last_seen_at.getTime(),
    );
  });

  it("extends expiry once lastSeenAt is over a day old", async () => {
    const { token } = await createSessionRecord(alpha.companyId, alpha.userId);

    await raw.query(
      `UPDATE sessions
         SET last_seen_at = now() - interval '2 days',
             expires_at   = now() + interval '5 days'`,
    );

    const before = await raw.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions",
    );

    await resolveSessionByToken(token);

    const after = await raw.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions",
    );

    expect(after.rows[0]!.expires_at.getTime()).toBeGreaterThan(
      before.rows[0]!.expires_at.getTime(),
    );
  });
});
