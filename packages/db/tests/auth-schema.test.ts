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
