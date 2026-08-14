import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testAppDatabaseUrl, testDatabaseUrl } from "../scripts/db-urls.mjs";

/**
 * The NO FORCE -> backfill -> FORCE sequence, executed rather than described.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 *
 * FORCE ROW LEVEL SECURITY subjects the table's owner to its own policies. The
 * policies here are scoped TO app_runtime, so the owner matches none of them
 * and sees nothing — which is exactly what makes tenant isolation hold even
 * against the migration role, and exactly what breaks a data-backfill
 * migration: a bare `UPDATE users SET ...` in a migration matches no policy and
 * silently touches zero rows.
 *
 * The documented workaround is to drop FORCE, backfill, and put it back. Until
 * now that pattern lived only in a comment, which meant the first time it ran
 * for real would be during a production deploy. This walks it end to end on a
 * throwaway table and asserts what is true at each step, so it is a worked
 * example that runs on every CI run.
 *
 * The conventions skill points here rather than restating it in prose.
 */

const TABLE = "force_rls_probe";

const owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
const runtime = new pg.Pool({ connectionString: testAppDatabaseUrl(), max: 2 });

/** Company id used for the seeded rows. Arbitrary; never leaves this file. */
const COMPANY = "probe-company-id";

async function dropTable(): Promise<void> {
  await owner.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
}

beforeAll(async () => {
  /*
   * Dropped first as well as last: a crashed run would otherwise leave the
   * table behind, and schema-invariants would fail on it in a way that looks
   * unrelated to this file.
   */
  await dropTable();

  await owner.query(`
    CREATE TABLE "${TABLE}" (
      id         text PRIMARY KEY,
      company_id text NOT NULL,
      label      text NOT NULL
    )
  `);

  /* The shape every tenant table has: composite index leading with company_id. */
  await owner.query(
    `CREATE INDEX "${TABLE}_company_id_label_idx" ON "${TABLE}" (company_id, label)`,
  );

  await owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO app_runtime`,
  );

  await owner.query(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await owner.query(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);

  await owner.query(`
    CREATE POLICY ${TABLE}_isolation ON "${TABLE}"
      AS PERMISSIVE FOR ALL TO app_runtime
      USING      (company_id = app_current_company())
      WITH CHECK (company_id = app_current_company())
  `);

  /* Seeded through the runtime role, in context — the real write path. */
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_id', $1, true)", [
      COMPANY,
    ]);
    await client.query(
      `INSERT INTO "${TABLE}" (id, company_id, label)
       VALUES ('a', $1, 'before'), ('b', $1, 'before')`,
      [COMPANY],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await dropTable();
  await owner.end();
  await runtime.end();
});

/** Is the policy present, whatever FORCE happens to be set to right now? */
async function policyCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = $1`,
    [TABLE],
  );
  return Number(rows[0]!.n);
}

async function forceFlags(): Promise<{ enabled: boolean; forced: boolean }> {
  const { rows } = await owner.query<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
    [TABLE],
  );
  return {
    enabled: rows[0]!.relrowsecurity,
    forced: rows[0]!.relforcerowsecurity,
  };
}

async function ownerRowCount(): Promise<number> {
  const { rows } = await owner.query(`SELECT id FROM "${TABLE}"`);
  return rows.length;
}

describe("step 1 — FORCE is on", () => {
  it("has RLS enabled and forced, with a policy", async () => {
    expect(await forceFlags()).toEqual({ enabled: true, forced: true });
    expect(await policyCount()).toBe(1);
  });

  it("hides every row from the owner", async () => {
    /* Two rows exist. The owner is subject to a policy it does not match. */
    expect(await ownerRowCount()).toBe(0);
  });

  it("hides them from a backfill UPDATE too", async () => {
    /*
     * The failure this whole sequence exists to prevent: the statement
     * succeeds, reports zero rows, and the migration carries on as though the
     * backfill had happened.
     */
    const result = await owner.query(
      `UPDATE "${TABLE}" SET label = 'backfilled'`,
    );
    expect(result.rowCount).toBe(0);
  });

  it("still shows both rows to the runtime role in context", async () => {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_id', $1, true)", [
        COMPANY,
      ]);
      const { rows } = await client.query(`SELECT label FROM "${TABLE}"`);
      await client.query("COMMIT");

      expect(rows).toHaveLength(2);
      expect(rows.every((r: { label: string }) => r.label === "before")).toBe(
        true,
      );
    } finally {
      client.release();
    }
  });
});

describe("step 2 — NO FORCE, then backfill", () => {
  it("returns the owner's exemption", async () => {
    await owner.query(`ALTER TABLE "${TABLE}" NO FORCE ROW LEVEL SECURITY`);

    const flags = await forceFlags();
    expect(flags.forced).toBe(false);
    /* ENABLE stays on: everyone else is still constrained throughout. */
    expect(flags.enabled).toBe(true);
  });

  it("keeps the policy in place while FORCE is off", async () => {
    /*
     * The window is narrow but it is real: dropping the policy instead of
     * FORCE would expose the table to app_runtime as well.
     */
    expect(await policyCount()).toBe(1);
  });

  it("lets the owner see and rewrite every row", async () => {
    expect(await ownerRowCount()).toBe(2);

    const result = await owner.query(
      `UPDATE "${TABLE}" SET label = 'backfilled'`,
    );
    expect(result.rowCount).toBe(2);
  });

  it("does not let the runtime role escape its company", async () => {
    /* app_runtime is unaffected by FORCE either way — it never was exempt. */
    const { rows } = await runtime.query(`SELECT id FROM "${TABLE}"`);
    expect(rows).toEqual([]);
  });
});

describe("step 3 — FORCE back on", () => {
  it("restores the owner's blindness", async () => {
    await owner.query(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);

    expect(await forceFlags()).toEqual({ enabled: true, forced: true });
    expect(await ownerRowCount()).toBe(0);
  });

  it("leaves the backfill applied and visible in context", async () => {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_id', $1, true)", [
        COMPANY,
      ]);
      const { rows } = await client.query(`SELECT label FROM "${TABLE}"`);
      await client.query("COMMIT");

      expect(rows).toHaveLength(2);
      expect(
        rows.every((r: { label: string }) => r.label === "backfilled"),
      ).toBe(true);
    } finally {
      client.release();
    }
  });

  it("ends in exactly the state it started in", async () => {
    /*
     * The property a migration has to preserve. Ending with FORCE off would
     * leave the owner permanently exempt, and nothing at runtime would notice.
     */
    expect(await forceFlags()).toEqual({ enabled: true, forced: true });
    expect(await policyCount()).toBe(1);
  });
});
