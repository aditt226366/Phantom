import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../scripts/db-urls.mjs";

/**
 * Rule 1 of CLAUDE.md, enforced by the database rather than by memory.
 *
 * The isolation suite proves the policies work on the tables that exist today.
 * This one proves the *next* table cannot skip them. It reads the live catalog
 * and fails if any tenant-owned table is missing a company_id, an index leading
 * with it, RLS, a policy, or the right grants — so the failure arrives when the
 * table is added, not the first time someone reads across tenants in
 * production.
 *
 * Tables opt out only by being named in one of the two lists below. Both are
 * constants in this file on purpose: adding to them is a visible diff in a
 * security-relevant place, which is exactly the review moment you want.
 */

/** Tenant root. Its key is `id`, so it has a policy but no company_id column. */
const SELF_KEYED_TABLES = new Set(["companies"]);

/**
 * Deliberately global — outside tenancy, with a reason each.
 *
 * Adding a name here is how a table opts out of every guarantee below, so it
 * should be a deliberate, reviewed diff rather than a quiet one.
 */
const GLOBAL_TABLES = new Set<string>([
  /*
   * Keyed on (username, ip), and the username may not exist. An attempt on an
   * unknown account has no company to attribute it to, and refusing to record
   * it would make the absence of a lockout row an existence oracle.
   */
  "login_attempts",
  /*
   * Platform-level, belonging to no company. Separate tables rather than a role
   * flag on User, so no code path can escalate a tenant session into an admin
   * one. app_runtime is denied all access — asserted below.
   */
  "admin_users",
  "admin_sessions",
  "admin_audit_log",
]);

/** Global tables holding admin credentials. app_runtime gets nothing here. */
const ADMIN_TABLES = ["admin_users", "admin_sessions", "admin_audit_log"];

/** Prisma's own bookkeeping. */
const INFRASTRUCTURE_TABLES = new Set(["_prisma_migrations"]);

let db: pg.Client;
let tenantTables: string[];

beforeAll(async () => {
  db = new pg.Client({ connectionString: testDatabaseUrl() });
  await db.connect();

  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );

  tenantTables = rows
    .map((r) => r.tablename)
    .filter(
      (name) =>
        !INFRASTRUCTURE_TABLES.has(name) &&
        !GLOBAL_TABLES.has(name) &&
        !SELF_KEYED_TABLES.has(name),
    );
});

afterAll(async () => {
  await db.end();
});

/** Every table that must be protected, whether keyed on company_id or on id. */
function protectedTables(): string[] {
  return [...tenantTables, ...SELF_KEYED_TABLES];
}

describe("the owning role", () => {
  /**
   * FORCE ROW LEVEL SECURITY only constrains the owner. If the owner is a
   * superuser it is exempt regardless, and every FORCE clause in every
   * migration silently becomes decoration. This is the invariant that keeps
   * that from happening quietly — including for tables added later, which is
   * the case ownership drift actually shows up in.
   */
  it("is not a superuser and does not bypass RLS", async () => {
    const { rows } = await db.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
       WHERE rolname = 'whatsapp_owner'`,
    );

    expect(rows, "whatsapp_owner does not exist — run npm run db:roles").toHaveLength(
      1,
    );
    expect(rows[0]?.rolsuper, "whatsapp_owner is a superuser").toBe(false);
    expect(rows[0]?.rolbypassrls, "whatsapp_owner has BYPASSRLS").toBe(false);
  });

  it("owns every table in public", async () => {
    const { rows } = await db.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner FROM pg_tables
       WHERE schemaname = 'public' AND tableowner <> 'whatsapp_owner'`,
    );

    /*
     * A table owned by anything else is exempt from FORCE in a way nothing
     * else in this suite would notice.
     */
    expect(
      rows.map((r) => `${r.tablename} (owned by ${r.tableowner})`),
      "tables not owned by whatsapp_owner — run npm run db:roles",
    ).toEqual([]);
  });

  it("has no role holding BYPASSRLS", async () => {
    const { rows } = await db.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
       WHERE rolbypassrls AND rolname IN ('whatsapp_owner', 'app_runtime', 'app_admin')`,
    );

    /*
     * app_admin reads across companies through an explicit per-table policy,
     * not BYPASSRLS. That is not a stylistic choice: CREATE ROLE ... BYPASSRLS
     * requires a real superuser, which RDS, Supabase and Neon do not provide,
     * so the role would be uncreatable in production.
     */
    expect(rows.map((r) => r.rolname)).toEqual([]);
  });
});

describe("schema invariants", () => {
  it("found tables to check", () => {
    /*
     * A filter bug that leaves this list empty would make every it.each below
     * vacuously pass. Fail loudly instead.
     */
    expect(protectedTables().length).toBeGreaterThan(0);
  });

  describe("tenant-owned tables", () => {
    it("have a NOT NULL company_id", async () => {
      for (const table of tenantTables) {
        const { rows } = await db.query<{ is_nullable: string }>(
          `SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
             AND column_name = 'company_id'`,
          [table],
        );

        expect(rows, `${table} has no company_id column`).toHaveLength(1);
        expect(rows[0]?.is_nullable, `${table}.company_id is nullable`).toBe(
          "NO",
        );
      }
    });

    it("have a composite index leading with company_id", async () => {
      for (const table of tenantTables) {
        /*
         * The leading column is what matters: Postgres can only use an index
         * for a company_id lookup if company_id is first. An index that merely
         * *contains* company_id does not satisfy the rule.
         */
        const { rows } = await db.query<{ indexname: string; cols: number }>(
          `SELECT i.relname AS indexname,
                  array_length(ix.indkey::int2[], 1) AS cols
           FROM pg_index ix
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_attribute a
             ON a.attrelid = t.oid AND a.attnum = ix.indkey[0]
           WHERE t.relname = $1
             AND t.relnamespace = 'public'::regnamespace
             AND a.attname = 'company_id'`,
          [table],
        );

        expect(
          rows.length,
          `${table} has no index whose first column is company_id`,
        ).toBeGreaterThan(0);

        expect(
          rows.some((r) => r.cols >= 2),
          `${table} has an index on company_id but none that is composite`,
        ).toBe(true);
      }
    });
  });

  describe("every protected table", () => {
    it("has row-level security enabled AND forced", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
           WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );

        expect(rows[0]?.relrowsecurity, `${table}: RLS not enabled`).toBe(true);
        /*
         * FORCE is what subjects the table's owner to its own policies. Without
         * it, a runtime connection that happens to own the tables — the normal
         * shape of a managed-Postgres migration user — is exempt from all of
         * this while looking perfectly ordinary.
         */
        expect(rows[0]?.relforcerowsecurity, `${table}: RLS not forced`).toBe(
          true,
        );
      }
    });

    it("has an isolation policy for app_runtime", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query<{ policyname: string; qual: string }>(
          `SELECT policyname, qual FROM pg_policies
           WHERE schemaname = 'public' AND tablename = $1
             AND 'app_runtime' = ANY(roles)`,
          [table],
        );

        expect(rows.length, `${table}: no app_runtime policy`).toBeGreaterThan(
          0,
        );

        /* The policy must actually consult the request context. */
        expect(
          rows.some((r) => r.qual?.includes("app_current_company")),
          `${table}: app_runtime policy does not reference app_current_company()`,
        ).toBe(true);
      }
    });

    it("scopes app_runtime writes, not only reads", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query<{
          policyname: string;
          with_check: string | null;
        }>(
          `SELECT policyname, with_check FROM pg_policies
           WHERE schemaname = 'public' AND tablename = $1
             AND 'app_runtime' = ANY(roles)`,
          [table],
        );

        /*
         * USING decides which rows are visible; WITH CHECK decides which rows
         * may be written.
         *
         * An absent WITH CHECK is safe: Postgres falls back to USING for
         * writes, and the assertion above already proves USING consults the
         * request context. A *present* one replaces that fallback entirely,
         * and that is the hole worth catching — a policy reading
         *
         *     USING      (company_id = app_current_company())
         *     WITH CHECK (true)
         *
         * looks right, satisfies every other assertion in this file, and lets
         * a write land under any company_id at all.
         */
        for (const row of rows) {
          if (row.with_check === null) continue;

          expect(
            row.with_check.includes("app_current_company"),
            `${table}: policy ${row.policyname} has a WITH CHECK that does not consult app_current_company()`,
          ).toBe(true);
        }
      }
    });

    it("has an access policy for app_admin, covering writes", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query<{ policyname: string; cmd: string }>(
          `SELECT policyname, cmd FROM pg_policies
           WHERE schemaname = 'public' AND tablename = $1
             AND 'app_admin' = ANY(roles)`,
          [table],
        );

        /*
         * app_admin is not BYPASSRLS, so it sees nothing without an explicit
         * policy. Forgetting one is a fail-closed bug — the admin panel goes
         * blank rather than the tenant boundary going away — but still a bug.
         */
        expect(rows.length, `${table}: no app_admin policy`).toBeGreaterThan(0);

        /*
         * And the command matters, not just the policy's existence. FOR SELECT
         * passes the check above and then fails at the first write the panel
         * attempts — which, from Phase 2 on, means Save, Disconnect and
         * Deactivate. Same fail-closed shape, discovered much later.
         */
        expect(
          rows.some((r) => r.cmd === "ALL"),
          `${table}: app_admin has a policy but none FOR ALL (found ${rows
            .map((r) => `${r.policyname} FOR ${r.cmd}`)
            .join(", ")})`,
        ).toBe(true);
      }
    });

    it("denies app_runtime everything on the admin tables", async () => {
      for (const table of ADMIN_TABLES) {
        const { rows } = await db.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'app_runtime'
             AND table_schema = 'public' AND table_name = $1`,
          [table],
        );

        /*
         * No RLS policy scopes a global table, so a stray default grant here
         * would let an ordinary tenant request read admin_users.password_hash.
         */
        expect(
          rows.map((r) => r.privilege_type),
          `${table}: app_runtime holds grants on an admin table`,
        ).toEqual([]);
      }
    });

    it("keeps app_resolver's reach into companies to three columns", async () => {
      const { rows: whole } = await db.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_resolver'
           AND table_schema = 'public' AND table_name = 'companies'`,
      );

      /*
       * The entire argument for giving app_resolver cross-company reach is
       * that it can see almost nothing. A whole-table grant is how that stops
       * being true silently: `deactivated_at` was readable by the resolver
       * before anything granted it, purely because the original grant was
       * wider than intended, and the next column added to companies would
       * have been too.
       */
      expect(
        whole.map((r) => r.privilege_type),
        "app_resolver holds a whole-table grant on companies",
      ).toEqual([]);

      const { rows: columns } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
         WHERE grantee = 'app_resolver'
           AND table_schema = 'public' AND table_name = 'companies'
         ORDER BY column_name`,
      );

      /* id and deactivated_at for app_resolve_company, slug for
         app_available_slug. Widening this is a migration and a diff here. */
      expect(columns.map((r) => r.column_name)).toEqual([
        "deactivated_at",
        "id",
        "slug",
      ]);
    });

    it("keeps the lookup functions owned by app_resolver", async () => {
      const { rows } = await db.query<{ proname: string; owner: string }>(
        `SELECT p.proname, p.proowner::regrole::text AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('app_resolve_company', 'app_available_slug')
         ORDER BY p.proname`,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        /*
         * A SECURITY DEFINER function runs as its owner. Reassigned to
         * whatsapp_owner — which FORCE RLS gives no visibility to — every
         * lookup would silently return NULL and sign-in would fail with
         * nothing in the logs. db-roles.mjs excludes them from its ownership
         * sweep for exactly this reason.
         */
        expect(row.owner, `${row.proname} is owned by ${row.owner}`).toBe(
          "app_resolver",
        );
      }
    });

    it("grants app_runtime CRUD but never TRUNCATE", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'app_runtime'
             AND table_schema = 'public' AND table_name = $1`,
          [table],
        );

        const held = rows.map((r) => r.privilege_type);
        expect(held, `${table}: missing CRUD grants`).toEqual(
          expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
        );

        /* TRUNCATE ignores RLS entirely — a one-statement bypass. */
        expect(held, `${table}: TRUNCATE is granted`).not.toContain("TRUNCATE");
      }
    });
  });
});
