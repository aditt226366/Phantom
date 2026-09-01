import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../scripts/db-urls.mjs";
import { COMPANY_SCOPED_MODELS } from "../src/with-company.ts";
import {
  COLUMN_GRANTS,
  OUT_OF_BAND_DDL,
  RESOLVER_TABLE_GRANTS,
  checkColumnGrants,
  checkOutOfBandDdl,
  checkResolverTableGrants,
} from "../scripts/invariants.mjs";

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
  /*
   * A platform-wide maintenance run. It spans every company by definition, so
   * a company_id would be meaningless, and the worker never writes here —
   * progress is derived from integration_verifications instead.
   */
  "admin_repair_runs",
  /*
   * An unknown webhook key resolves to no company, so there is nothing to
   * attribute the row to - which is the whole reason this is not part of
   * whatsapp_webhook_events. Written by an unauthenticated endpoint, read only
   * by the platform admin, and app_runtime's default grants are revoked in the
   * migration.
   */
  "unroutable_webhooks",
]);

/** Global tables holding admin credentials. app_runtime gets nothing here. */
const ADMIN_TABLES = [
  "admin_users",
  "admin_sessions",
  "admin_audit_log",
  "admin_repair_runs",
];




/**
 * Tenant-owned models deliberately absent from COMPANY_SCOPED_MODELS.
 *
 * Membership of that set is what injects company_id on create and merges it
 * into every where. Absence is not a hole — RLS still refuses the cross-company
 * read — but it is defence in depth switched off, so each exemption carries a
 * reason rather than being an oversight nobody noticed.
 */
const UNSCOPED_MODELS = new Map<string, string>([
  [
    "Company",
    "its tenant key is `id`, not `company_id`, so an injected filter would " +
      "produce invalid queries. Its RLS policy covers it.",
  ],
  [
    "Session",
    "written before a company context exists — sign-in resolves the company " +
      "from the session row, not the other way round.",
  ],
  [
    "EmailVerificationToken",
    "consumed from an unauthenticated link, through resolveCompany.",
  ],
  ["PasswordResetToken", "same as EmailVerificationToken."],
  [
    "AuditLog",
    "written on paths that already hold an explicit companyId, including ones " +
      "with no session at all.",
  ],
]);

/**
 * Tenant-owned tables whose company_id index is deliberately NOT composite.
 *
 * The composite rule exists because a tenant table's hot queries filter by
 * company_id *and something else*, and an index on company_id alone leaves the
 * second predicate to a filter over every row the company owns. That reasoning
 * has a precondition: more than one row per company.
 *
 * A table with exactly one row per company has nothing to add a second column
 * for. Its primary key is the whole lookup, every read is a single-row fetch by
 * that key, and a `(company_id, computed_at)` index would be decoration -
 * implying a query shape that does not exist, which is worse than the honest
 * absence because the next person would try to use it.
 *
 * This exempts the composite check and NOTHING else. Every table below still
 * needs a NOT NULL company_id, RLS enabled and forced, an app_runtime isolation
 * policy, an app_admin policy and the ordinary grants - all asserted for it
 * exactly as for any other tenant table.
 */
const SINGLE_ROW_PER_COMPANY_TABLES = new Map<string, string>([
  [
    "dashboard_rollups",
    "one row per company by primary key. See 20260905090000: the row is a " +
      "single upsert so that one computed_at covers every figure above it, " +
      "and a second index column would describe a read nothing performs.",
  ],
]);

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

        /*
         * Exempt tables still had to pass the two assertions above: an index
         * whose FIRST column is company_id has to exist either way. What is
         * waived is only the second column.
         */
        if (SINGLE_ROW_PER_COMPANY_TABLES.has(table)) continue;

        expect(
          rows.some((r) => r.cols >= 2),
          `${table} has an index on company_id but none that is composite`,
        ).toBe(true);
      }
    });

    it("carries a reason for every table waived from the composite rule", () => {
      /*
       * Both directions, like GLOBAL_TABLES. A name that no longer describes a
       * table in the schema is an exemption nobody is reading, and an entry
       * with no reason is a name somebody added to make a test go green.
       */
      for (const [table, reason] of SINGLE_ROW_PER_COMPANY_TABLES) {
        expect(
          tenantTables,
          `${table} is waived from the composite rule but is not a tenant table`,
        ).toContain(table);
        expect(
          reason.length,
          `${table} is waived with no reason`,
        ).toBeGreaterThan(40);
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

    it("holds a whole-table grant only where the allowlist says", async () => {
      /*
       * The assertion runs from scripts/invariants.mjs, which is also what
       * `npm run db:verify` points at another database. One implementation, so
       * a suite that is green cannot mean a different thing from a clean
       * report against dev or production - which is exactly the gap that let
       * dev drift for eight commits (C10).
       */
      expect(
        await checkResolverTableGrants(db),
        "app_resolver's whole-table grants have changed",
      ).toEqual([]);
    });

    it("holds a column grant only where the allowlist says", async () => {
      /*
       * Column grants live in pg_attribute.attacl, not pg_class.relacl, so
       * information_schema.column_privileges cannot see them and neither can
       * `prisma migrate diff`. See scripts/invariants.mjs.
       */
      expect(
        await checkColumnGrants(db),
        "column grants have changed — widen COLUMN_GRANTS deliberately or revoke",
      ).toEqual([]);
    });

    it("has no reach that neither allowlist accounts for", async () => {
      /*
       * The joint assertion, and the one that makes "the only cross-company
       * capability in the system is a single text value out" a checkable claim.
       *
       * The two allowlists are otherwise independent checks with a gap between
       * them: a whole-table grant is compared against RESOLVER_TABLE_GRANTS, a
       * column grant against COLUMN_GRANTS, and a grant on a table named in
       * neither list satisfies both — because each query only looks where its
       * own list already points.
       *
       * So this asks the opposite question. Everything app_resolver holds
       * anywhere in the schema, table-level and column-level together, against
       * everything the two lists say it should.
       */
      const { rows } = await db.query<{ entry: string }>(
        `SELECT c.relname || ':' || acl.privilege_type AS entry
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
           JOIN pg_roles r ON r.oid = acl.grantee
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND r.rolname = 'app_resolver'
         UNION ALL
         SELECT c.relname || '.' || a.attname || ':' || acl.privilege_type
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
           JOIN pg_roles r ON r.oid = acl.grantee
          WHERE n.nspname = 'public'
            AND a.attnum > 0 AND NOT a.attisdropped
            AND r.rolname = 'app_resolver'
          ORDER BY entry`,
      );

      /* Whole-table entries are SELECT by construction — anything else on a
         resolver table is precisely what this is looking for, so it is built
         in rather than assumed away. */
      const expected = [
        ...[...RESOLVER_TABLE_GRANTS].map((table) => `${table}:SELECT`),
        ...[...COLUMN_GRANTS]
          .filter((entry) => entry.includes(":app_resolver:"))
          .map((entry) => entry.replace(":app_resolver:", ":")),
      ].sort();

      expect(
        rows.map((r) => r.entry),
        "app_resolver's total footprint is not what the two allowlists describe",
      ).toEqual(expected);
    });

    it("keeps the lookup functions owned by app_resolver, and definer", async () => {
      const { rows } = await db.query<{
        proname: string;
        owner: string;
        prosecdef: boolean;
      }>(
        `SELECT p.proname, p.proowner::regrole::text AS owner, p.prosecdef
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

        /*
         * The other half of the same failure, and the one a CREATE OR REPLACE
         * can drop by omission: SECURITY INVOKER is the default, so a rewrite
         * that forgets the clause keeps the right owner and still runs as
         * app_runtime. The symptom is identical — every lookup returns NULL,
         * sign-in stops working, and nothing in the logs mentions the
         * migration that did it.
         */
        expect(
          row.prosecdef,
          `${row.proname} is not SECURITY DEFINER`,
        ).toBe(true);
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

  describe("the withCompany extension", () => {
    /**
     * Model name for each mapped table, parsed from schema.prisma.
     *
     * Parsed rather than grepped, comments stripped first: a /// doc comment
     * mentioning @@map would otherwise be read as one. There is no generated
     * manifest to use instead — Prisma 7's client does not expose DMMF at
     * runtime.
     */
    function modelsByTable(): Map<string, string> {
      const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "schema.prisma"),
        "utf8",
      ).replace(/^\s*\/\/.*$/gm, "");

      const byTable = new Map<string, string>();

      for (const [, model, body] of source.matchAll(
        /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm,
      )) {
        const mapped = /@@map\("([^"]+)"\)/.exec(body ?? "");
        if (mapped) byTable.set(mapped[1]!, model!);
      }

      return byTable;
    }

    it("scopes every tenant-owned model, or says why not", () => {
      /*
       * COMPANY_SCOPED_MODELS injects company_id on create and merges it into
       * every where. A tenant table missing from it is not an immediate hole —
       * RLS still refuses the cross-company read — but defence in depth is off,
       * and a create without an explicit companyId then fails with an opaque
       * "new row violates row-level security policy" from a background job
       * rather than working.
       *
       * whatsapp_media shipped that way in 20260815140000 and nothing noticed,
       * because its tests happened to pass companyId by hand. The existing
       * backstop covers the policy; this covers the set.
       */
      const byTable = modelsByTable();

      expect(byTable.size, "schema.prisma parsed to no models").toBeGreaterThan(10);

      const unaccounted = protectedTables()
        .map((table) => ({ table, model: byTable.get(table) }))
        .filter(
          (entry) =>
            entry.model &&
            !COMPANY_SCOPED_MODELS.has(entry.model) &&
            !UNSCOPED_MODELS.has(entry.model),
        )
        .map((entry) => `${entry.table} (${entry.model})`);

      expect(
        unaccounted.sort(),
        "tenant tables in neither COMPANY_SCOPED_MODELS nor UNSCOPED_MODELS",
      ).toEqual([]);
    });

    it("names only models that exist", () => {
      /*
       * A renamed model leaves a stale entry that scopes nothing, and the set
       * still looks complete.
       */
      const models = new Set(modelsByTable().values());

      expect(
        [...COMPANY_SCOPED_MODELS].filter((m) => !models.has(m)).sort(),
        "COMPANY_SCOPED_MODELS names models that do not exist",
      ).toEqual([]);
      expect(
        [...UNSCOPED_MODELS.keys()].filter((m) => !models.has(m)).sort(),
        "UNSCOPED_MODELS names models that do not exist",
      ).toEqual([]);
    });

    it("does not both scope and exempt the same model", () => {
      /* Two answers to one question means the reason went unread. */
      expect(
        [...UNSCOPED_MODELS.keys()].filter((m) => COMPANY_SCOPED_MODELS.has(m)).sort(),
      ).toEqual([]);
    });
  });

  describe("DDL that schema.prisma cannot express", () => {
    it("is exactly what the allowlist names", async () => {
      /*
       * CHECK constraints, column storage, triggers and exclusion constraints -
       * everything schema.prisma cannot express and the drift check therefore
       * cannot see. Swept in both directions from scripts/invariants.mjs.
       */
      expect(
        await checkOutOfBandDdl(db),
        "out-of-band DDL has changed — update OUT_OF_BAND_DDL deliberately",
      ).toEqual([]);
    });
  });
});
