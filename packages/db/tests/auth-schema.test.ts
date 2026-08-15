import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCompany,
  newCompanyId,
  resolveCompany,
  slugify,
  withCompany,
} from "../src/index.ts";
import {
  rawRuntimeClient,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

let raw: pg.Pool;
let alpha: SeededCompany;
let beta: SeededCompany;

beforeAll(() => {
  raw = rawRuntimeClient();
});

afterAll(async () => {
  await raw.end();
});

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

describe("app_resolve_company", () => {
  it("maps a username to its company", async () => {
    const resolved = await resolveCompany("username", alpha.usernames[0]!);
    expect(resolved).toBe(alpha.id);
  });

  it("maps the other company's username to the other company", async () => {
    const resolved = await resolveCompany("username", beta.usernames[0]!);
    expect(resolved).toBe(beta.id);
  });

  it("returns null for an unknown username", async () => {
    /*
     * Null rather than throwing: an unknown username must take the same code
     * path as a known one, or the difference becomes an account-existence
     * oracle before a password is ever checked.
     */
    expect(await resolveCompany("username", "nobody")).toBeNull();
  });

  it("hands over an id and nothing else", async () => {
    /*
     * The whole justification for the SECURITY DEFINER escape hatch. It can
     * resolve any username in the installation, but the caller still cannot
     * read a single row it did not already have access to.
     */
    const resolved = await resolveCompany("username", beta.usernames[0]!);
    expect(resolved).toBe(beta.id);

    const direct = await raw.query("SELECT * FROM users WHERE username = $1", [
      beta.usernames[0],
    ]);
    expect(direct.rows).toEqual([]);
  });

  it("only resolves live sessions", async () => {
    const tokenHash = "session-token-hash-live";

    await withCompany(alpha.id, async (db, companyId) => {
      await db.session.create({
        data: {
          companyId,
          userId: alpha.userIds[0]!,
          tokenHash,
          csrfSecret: "csrf",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    });

    expect(await resolveCompany("session", tokenHash)).toBe(alpha.id);

    await withCompany(alpha.id, (db) =>
      db.session.updateMany({
        where: { tokenHash },
        data: { revokedAt: new Date() },
      }),
    );

    /* Revocation is immediate — that is the point of server-side sessions. */
    expect(await resolveCompany("session", tokenHash)).toBeNull();
  });

  it("does not resolve an expired session", async () => {
    const tokenHash = "session-token-hash-expired";

    await withCompany(alpha.id, async (db, companyId) => {
      await db.session.create({
        data: {
          companyId,
          userId: alpha.userIds[0]!,
          tokenHash,
          csrfSecret: "csrf",
          expiresAt: new Date(Date.now() - 1_000),
        },
      });
    });

    expect(await resolveCompany("session", tokenHash)).toBeNull();
  });

  it("rejects an unknown lookup kind", async () => {
    await expect(
      // @ts-expect-error deliberately outside the union
      resolveCompany("passwords", "x"),
    ).rejects.toThrow(/unknown lookup kind/i);
  });

  it("answers every kind it declares, in one pass", async () => {
    /*
     * The regression guard for CREATE OR REPLACE.
     *
     * The function is rewritten whole every time a kind is added, so a typo in
     * a branch a migration did not mean to touch is silently shipped — and the
     * five older branches are load-bearing for sign-in, session resolution,
     * email verification and password reset. That failure presents as "sign-in
     * is broken", days later, with nothing pointing at the migration.
     *
     * Every kind in one test rather than one test each, deliberately: the
     * claim is that the SET is intact after a rewrite, and a suite where five
     * pass and one fails reads very differently from five separate files.
     */
    const tokenHash = "all-kinds-token-hash";
    const resetHash = "all-kinds-reset-hash";
    const verifyHash = "all-kinds-verify-hash";
    const expiresAt = new Date(Date.now() + 60_000);

    const webhookKey = await withCompany(
      alpha.id,
      async (db, companyId): Promise<string> => {
        await db.session.create({
          data: {
            companyId,
            userId: alpha.userIds[0]!,
            tokenHash,
            csrfSecret: "csrf",
            expiresAt,
          },
        });
        await db.passwordResetToken.create({
          data: { companyId, userId: alpha.userIds[0]!, tokenHash: resetHash, expiresAt },
        });
        await db.emailVerificationToken.create({
          data: { companyId, userId: alpha.userIds[0]!, tokenHash: verifyHash, expiresAt },
        });

        const integration = await db.integration.create({
          data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
          select: { webhookKey: true },
        });
        return integration.webhookKey;
      },
    );

    const answers = {
      username: await resolveCompany("username", alpha.usernames[0]!),
      email: await resolveCompany("email", "user0@alpha.test"),
      session: await resolveCompany("session", tokenHash),
      verification: await resolveCompany("verification", verifyHash),
      password_reset: await resolveCompany("password_reset", resetHash),
      webhook: await resolveCompany("webhook", webhookKey),
    };

    /*
     * One object comparison rather than six assertions: a missing key is then
     * as loud as a wrong value, and the diff names the branch that broke.
     */
    expect(answers).toEqual({
      username: alpha.id,
      email: alpha.id,
      session: alpha.id,
      verification: alpha.id,
      password_reset: alpha.id,
      webhook: alpha.id,
    });
  });
});

describe("resolving a webhook key", () => {
  /** Seeds an integration and hands back the key Meta would post to. */
  async function seedIntegration(
    company: SeededCompany,
    provider: "WHATSAPP_CLOUD" | "GOOGLE_SHEETS",
  ): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider, label: provider },
        select: { webhookKey: true },
      });
      return integration.webhookKey;
    });
  }

  it("maps a key to the company that owns it", async () => {
    const alphaKey = await seedIntegration(alpha, "WHATSAPP_CLOUD");
    const betaKey = await seedIntegration(beta, "WHATSAPP_CLOUD");

    expect(await resolveCompany("webhook", alphaKey)).toBe(alpha.id);
    expect(await resolveCompany("webhook", betaKey)).toBe(beta.id);
  });

  it("returns null for a key nobody holds", async () => {
    /*
     * The endpoint answers 200 to this, not 404 — a rotated key or a stale Meta
     * config would otherwise burn toward subscription disablement. That is the
     * handler's decision; this only has to say "no company".
     */
    expect(await resolveCompany("webhook", "0".repeat(32))).toBeNull();
  });

  it("ignores a key belonging to a non-WhatsApp integration", async () => {
    /*
     * Every integration has a webhook_key, because 20260815110000 gave the
     * column a NOT NULL default. Without the provider constraint a Sheets key
     * would resolve, the handler would open the correct company, and then fail
     * hunting for WhatsApp credentials that were never stored — a confusing
     * failure at the least debuggable point in the system.
     */
    const sheetsKey = await seedIntegration(alpha, "GOOGLE_SHEETS");

    expect(await resolveCompany("webhook", sheetsKey)).toBeNull();
  });

  it("still resolves for a deactivated company", async () => {
    /*
     * The deliberate asymmetry with all five other kinds, and the one most
     * likely to be "fixed" by someone matching the pattern.
     *
     * Meta keeps delivering to a suspended workspace's number. Refusing here
     * would 404 Meta, and about a week of failures disables the subscription
     * outright — so reactivating would leave a dead webhook nobody is told
     * about and every message from the suspension gone. The worker declines to
     * act; the resolver still answers.
     */
    const key = await seedIntegration(alpha, "WHATSAPP_CLOUD");

    expect(await resolveCompany("webhook", key)).toBe(alpha.id);

    await withCompany(alpha.id, (db) =>
      db.company.update({
        where: { id: alpha.id },
        data: { deactivatedAt: new Date() },
      }),
    );

    expect(await resolveCompany("webhook", key)).toBe(alpha.id);

    /* And the contrast, in the same test, so the asymmetry is the assertion. */
    expect(await resolveCompany("username", alpha.usernames[0]!)).toBeNull();
  });
});

describe("a deactivated company", () => {
  /** Suspend `alpha`. Written through the real path, like every other fixture. */
  async function deactivate(): Promise<void> {
    await withCompany(alpha.id, (db) =>
      db.company.update({
        where: { id: alpha.id },
        data: { deactivatedAt: new Date() },
      }),
    );
  }

  it("stops resolving a username, so sign-in cannot proceed", async () => {
    /*
     * Asserted live first. A username that never resolved would make the
     * second half pass for the wrong reason, which is the whole failure mode
     * these two-step assertions exist to rule out.
     */
    expect(await resolveCompany("username", alpha.usernames[0]!)).toBe(alpha.id);

    await deactivate();

    expect(await resolveCompany("username", alpha.usernames[0]!)).toBeNull();
  });

  it("stops resolving a session that was valid a moment ago", async () => {
    const tokenHash = "session-token-hash-deactivated";

    await withCompany(alpha.id, async (db, companyId) => {
      await db.session.create({
        data: {
          companyId,
          userId: alpha.userIds[0]!,
          tokenHash,
          csrfSecret: "csrf",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    });

    /*
     * Unrevoked and unexpired throughout — so the null below is deactivation
     * and cannot be the session lifecycle assertions above wearing a hat.
     */
    expect(await resolveCompany("session", tokenHash)).toBe(alpha.id);

    await deactivate();

    expect(await resolveCompany("session", tokenHash)).toBeNull();
  });

  it("stops resolving a pending reset link", async () => {
    /*
     * A reset link outliving suspension would be the useful one to an
     * attacker: suspending a compromised workspace would leave the way back in
     * sitting in an inbox.
     */
    const tokenHash = "reset-token-hash-deactivated";

    await withCompany(alpha.id, async (db, companyId) => {
      await db.passwordResetToken.create({
        data: {
          companyId,
          userId: alpha.userIds[0]!,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    });

    expect(await resolveCompany("password_reset", tokenHash)).toBe(alpha.id);

    await deactivate();

    expect(await resolveCompany("password_reset", tokenHash)).toBeNull();
  });

  it("leaves every other company alone", async () => {
    await deactivate();

    /* A clause on the wrong side of the join would take out the installation. */
    expect(await resolveCompany("username", beta.usernames[0]!)).toBe(beta.id);
  });
});

describe("slug allocation", () => {
  it("slugifies a name", () => {
    expect(slugify("Acme Widgets Ltd")).toBe("acme-widgets-ltd");
    expect(slugify("  Café  Ünicode  ")).toBe("cafe-unicode");
    expect(slugify("!!!")).toBe("");
  });

  it("gives two companies with identical names distinct slugs", async () => {
    /*
     * The case this exists for. Two companies may legitimately share a name;
     * "that company name is taken" would be untrue and would disclose that
     * another tenant exists.
     */
    const first = newCompanyId();
    const second = newCompanyId();

    const a = await withCompany(first, (db, companyId) =>
      createCompany(db, companyId, "Identical Name"),
    );
    const b = await withCompany(second, (db, companyId) =>
      createCompany(db, companyId, "Identical Name"),
    );

    expect(a.name).toBe("Identical Name");
    expect(b.name).toBe(a.name);

    expect(a.slug).toBe("identical-name");
    expect(b.slug).not.toBe(a.slug);
    expect(b.slug).toMatch(/^identical-name-[0-9a-f]{4,}$/);
  });

  it("keeps allocating for a run of identical names", async () => {
    const slugs = new Set<string>();

    for (let i = 0; i < 6; i++) {
      const id = newCompanyId();
      const company = await withCompany(id, (db, companyId) =>
        createCompany(db, companyId, "Same Name"),
      );
      slugs.add(company.slug);
    }

    expect(slugs.size).toBe(6);
  });

  it("falls back for a name with no usable characters", async () => {
    const id = newCompanyId();
    const company = await withCompany(id, (db, companyId) =>
      createCompany(db, companyId, "🙂🙂🙂"),
    );

    expect(company.slug).toMatch(/^company/);
  });
});

describe("global tables", () => {
  it("lets app_runtime count failures for a username that does not exist", async () => {
    /*
     * login_attempts is global precisely because of this row: an attempt on an
     * unknown username has no company to attribute it to, and refusing to
     * record it would make the absence of a lockout an existence oracle.
     */
    await raw.query(
      `INSERT INTO login_attempts (id, username, ip, failure_count, last_failure_at)
       VALUES ('la1', 'ghost', '203.0.113.9', 1, now())`,
    );

    const { rows } = await raw.query(
      "SELECT failure_count FROM login_attempts WHERE username = 'ghost'",
    );
    expect(rows[0].failure_count).toBe(1);
  });

  it("supports the per-username aggregate row alongside the per-IP one", async () => {
    /*
     * Per-IP lockout alone is defeated by the IP rotation real credential
     * stuffing uses, so a second row shape counts failures for the username
     * across every address, with a looser threshold.
     */
    await raw.query(
      `INSERT INTO login_attempts (id, username, ip, failure_count, last_failure_at)
       VALUES ('la_ip', 'victim', '198.51.100.4', 3, now()),
              ('la_all', 'victim', '*', 21, now())`,
    );

    const { rows } = await raw.query(
      `SELECT ip, failure_count FROM login_attempts
       WHERE username = 'victim' ORDER BY ip`,
    );

    expect(rows).toEqual([
      { ip: "*", failure_count: 21 },
      { ip: "198.51.100.4", failure_count: 3 },
    ]);
  });

  it("refuses app_runtime any access to the admin tables", async () => {
    /*
     * These are global, so no policy scopes them. Without an explicit revoke
     * they would inherit the default grants and an ordinary tenant request
     * could read admin_users.password_hash.
     */
    for (const table of ["admin_users", "admin_sessions", "admin_audit_log"]) {
      await expect(raw.query(`SELECT * FROM ${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });
});
