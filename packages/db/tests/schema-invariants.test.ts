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
 * Nothing qualifies yet. When the auth schema lands, login_attempts belongs
 * here (it is keyed on a username that may not exist, so there is no company
 * to attribute it to) along with the platform-admin tables.
 */
const GLOBAL_TABLES = new Set<string>([]);

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

    it("has an access policy for app_admin", async () => {
      for (const table of protectedTables()) {
        const { rows } = await db.query(
          `SELECT policyname FROM pg_policies
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
