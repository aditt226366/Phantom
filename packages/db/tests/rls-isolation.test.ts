import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, withCompany } from "../src/index.ts";
import {
  ownerClient,
  rawRuntimeClient,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The point of the phase.
 *
 * Every test below deliberately bypasses withCompany and talks to the database
 * directly, because that is the only thing worth proving. An application-layer
 * filter is a convention: it stops the mistakes, not the attacker, and not the
 * raw query someone adds in six months. What must hold is that the *database*
 * refuses, whatever the caller does.
 *
 * If this file goes green while the policies are broken, it is worse than
 * useless — which is why it starts by proving it is connected as a role that
 * RLS actually applies to.
 */

let raw: pg.Pool;
let owner: pg.Pool;
let alpha: SeededCompany;
let beta: SeededCompany;

beforeAll(() => {
  raw = rawRuntimeClient();
  owner = ownerClient();
});

afterAll(async () => {
  await raw.end();
  await owner.end();
});

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

describe("guard", () => {
  /*
   * This must pass before any assertion below means anything. Pointed at the
   * owner or a superuser, every "returns no rows" test would go green by
   * default and prove precisely nothing.
   */
  it("is connected as a role that RLS applies to", async () => {
    const { rows } = await raw.query(
      `SELECT current_user AS role,
              rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );

    expect(rows[0].role).toBe("app_runtime");
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("seeded two distinct companies", () => {
    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.userIds).toHaveLength(2);
    expect(beta.userIds).toHaveLength(2);
  });
});

describe("reads without a company context", () => {
  it("returns nothing through the ORM", async () => {
    const users = await prisma.user.findMany();
    expect(users).toEqual([]);
  });

  it("returns nothing through raw SQL", async () => {
    /*
     * withCompany's docstring has always admitted that $queryRaw slips past the
     * extension. This is the assertion that the admission no longer matters.
     */
    const { rows } = await raw.query("SELECT * FROM users");
    expect(rows).toEqual([]);
  });

  it("hides companies too", async () => {
    const { rows } = await raw.query("SELECT * FROM companies");
    expect(rows).toEqual([]);
  });
});

describe("reads with a company context", () => {
  it("returns only that company's users", async () => {
    const users = await withCompany(alpha.id, (db) => db.user.findMany());

    expect(users).toHaveLength(2);
    expect(users.every((u) => u.companyId === alpha.id)).toBe(true);
  });

  it("returns only that company's own row from companies", async () => {
    const companies = await withCompany(alpha.id, (db) =>
      db.company.findMany(),
    );

    expect(companies).toHaveLength(1);
    expect(companies[0]?.id).toBe(alpha.id);
  });

  it("cannot reach another company by raw SQL from inside a valid context", async () => {
    /*
     * The one that matters most. The caller holds a legitimate session for
     * alpha and deliberately goes looking for beta's rows in raw SQL that no
     * application-layer filter ever inspects.
     */
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE company_id = ${beta.id}`,
    );

    expect(rows).toEqual([]);
  });

  it("cannot reach another company's row by primary key", async () => {
    const stolen = await withCompany(alpha.id, (db) =>
      db.user.findUnique({ where: { id: beta.userIds[0]! } }),
    );

    /* null, not a 403 — the row does not exist as far as this caller knows. */
    expect(stolen).toBeNull();
  });
});

describe("writes across companies", () => {
  it("updates nothing", async () => {
    const affected = await withCompany(alpha.id, (db) =>
      db.$executeRaw`UPDATE users SET full_name = 'pwned' WHERE company_id = ${beta.id}`,
    );

    expect(affected).toBe(0);

    const names = await withCompany(beta.id, (db) =>
      db.user.findMany({ select: { fullName: true } }),
    );
    expect(names.every((u) => u.fullName !== "pwned")).toBe(true);
  });

  it("deletes nothing", async () => {
    const affected = await withCompany(alpha.id, (db) =>
      db.$executeRaw`DELETE FROM users WHERE company_id = ${beta.id}`,
    );

    expect(affected).toBe(0);

    const survivors = await withCompany(beta.id, (db) => db.user.findMany());
    expect(survivors).toHaveLength(2);
  });

  it("rejects an insert into another company via raw SQL", async () => {
    /*
     * Reads fail closed silently (zero rows). Writes fail closed loudly, because
     * WITH CHECK raises rather than filtering. Assert on the error, not a count.
     *
     * Every NOT NULL column is supplied deliberately. A row that would be
     * rejected by a constraint anyway proves nothing about RLS — the test would
     * stay green if every policy on the table were dropped.
     */
    await expect(
      withCompany(
        alpha.id,
        (db) =>
          db.$executeRaw`
            INSERT INTO users (
              id, company_id, full_name, email, username,
              password_hash, phone_e164, password_changed_at,
              created_at, updated_at
            )
            VALUES (
              'smuggled', ${beta.id}, 'Smuggled', 'smuggled@beta.test',
              'smuggled', '$argon2id$placeholder', '+919876500000', now(),
              now(), now()
            )
          `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("rejects an insert into another company via the ORM", async () => {
    /*
     * The extension would otherwise overwrite the caller's companyId with the
     * scope's, landing the row in alpha. Safe, but silent — and a call site
     * that thinks it is writing to beta is a bug, not something to quietly
     * correct into working code.
     */
    await expect(
      withCompany(alpha.id, (db) =>
        db.user.create({
          data: {
            companyId: beta.id,
            fullName: "Smuggled",
            email: "x@beta.test",
            username: "smuggled_orm",
            passwordHash: "$argon2id$placeholder",
            phoneE164: "+919876500001",
          },
        }),
      ),
    ).rejects.toThrow(/cannot create a row for company/i);
  });

  it("leaves the other company untouched after a rejected write", async () => {
    await withCompany(alpha.id, (db) =>
      db.user
        .create({
          data: {
            companyId: beta.id,
            fullName: "Smuggled",
            email: "x@beta.test",
            username: "smuggled_untouched",
            passwordHash: "$argon2id$placeholder",
            phoneE164: "+919876500002",
          },
        })
        .catch(() => undefined),
    );

    const betaUsers = await withCompany(beta.id, (db) => db.user.findMany());
    expect(betaUsers).toHaveLength(2);
    expect(betaUsers.every((u) => u.email !== "x@beta.test")).toBe(true);

    const alphaUsers = await withCompany(alpha.id, (db) => db.user.findMany());
    expect(alphaUsers).toHaveLength(2);
  });

  it("rejects creating a company whose id is not the current context", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.company.create({
          data: { id: "some-other-id", slug: "sneaky", name: "Sneaky" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("the table owner", () => {
  /** Every table whose owner must still be subject to its own policies. */
  const TENANT_TABLES = ["users", "companies"] as const;

  it("is not a superuser and does not bypass RLS", async () => {
    /*
     * This is what makes the next test mean anything. A superuser ignores RLS
     * unconditionally — FORCE or not — so if the owner were the container's
     * postgres superuser, "the owner sees nothing" would be untestable and the
     * FORCE clause would be decorative.
     */
    const { rows } = await owner.query(
      `SELECT current_user AS role, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );

    expect(rows[0].role).toBe("whatsapp_owner");
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("owns these tables", async () => {
    const { rows } = await owner.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tableowner = current_user
       ORDER BY tablename`,
    );

    const owned = rows.map((r: { tablename: string }) => r.tablename);
    for (const table of TENANT_TABLES) {
      expect(owned, `${table} is not owned by the connecting role`).toContain(
        table,
      );
    }
  });

  it.each(TENANT_TABLES)(
    "sees no rows in %s without a company context",
    async (table) => {
      /*
       * The only direct proof that FORCE ROW LEVEL SECURITY does anything.
       *
       * The connection owns this table and there are seeded rows in it. ENABLE
       * alone would let the owner read every one of them; FORCE is what
       * subjects the owner to the same policies as everyone else, and those
       * policies are scoped TO app_runtime / app_admin, so this role matches
       * none of them and the table reads as empty.
       */
      const { rows } = await owner.query(`SELECT * FROM "${table}"`);

      expect(rows, `${table}: FORCE ROW LEVEL SECURITY is not in effect`).toEqual(
        [],
      );
    },
  );

  it("can still TRUNCATE, which is why app_runtime must not", async () => {
    /*
     * TRUNCATE ignores RLS entirely. The owner keeps it because the test
     * harness needs it; app_runtime is denied it precisely because it would be
     * a one-statement bypass of every policy above.
     */
    await expect(owner.query('TRUNCATE TABLE "users" CASCADE')).resolves.toBeDefined();

    await expect(
      raw.query('TRUNCATE TABLE "users" CASCADE'),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the company context does not leak", () => {
  it("is gone once the transaction ends", async () => {
    /*
     * The regression this guards against is someone "simplifying" withCompany
     * back to a plain SET outside a transaction. That would work in every test
     * above and silently hand one tenant's context to the next request that
     * borrows the same pooled connection.
     *
     * raw is a pool of exactly 1, so this is the same physical connection.
     */
    await withCompany(alpha.id, (db) => db.user.findMany());

    const { rows } = await raw.query(
      "SELECT current_setting('app.company_id', true) AS company",
    );
    expect(rows[0].company === null || rows[0].company === "").toBe(true);

    const after = await raw.query("SELECT * FROM users");
    expect(after.rows).toEqual([]);
  });

  it("keeps concurrent scopes apart", async () => {
    for (let round = 0; round < 10; round++) {
      const [alphaUsers, betaUsers] = await Promise.all([
        withCompany(alpha.id, (db) => db.user.findMany()),
        withCompany(beta.id, (db) => db.user.findMany()),
      ]);

      expect(alphaUsers.every((u) => u.companyId === alpha.id)).toBe(true);
      expect(betaUsers.every((u) => u.companyId === beta.id)).toBe(true);
      expect(alphaUsers).toHaveLength(2);
      expect(betaUsers).toHaveLength(2);
    }
  });
});
