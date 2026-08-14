import { describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "../src/index.ts";
import { TEST_DATABASE_NAME } from "../scripts/db-urls.mjs";

/**
 * Proves the harness itself works: the test database exists, migrations were
 * applied to it, and the lazy client picked up the redirected DATABASE_URL.
 *
 * If this file fails, nothing else in the db project can be trusted.
 */

describe("test harness", () => {
  it("connects to the database", async () => {
    await expect(checkDatabase()).resolves.toBe(true);
  });

  it("is pointed at the test database, not the dev one", async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ db: string }>
    >`SELECT current_database() AS db`;

    expect(row?.db).toBe(TEST_DATABASE_NAME);
  });

  it("has the renamed schema applied", async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companies', 'users')
      ORDER BY table_name
    `;

    expect(tables.map((t) => t.table_name)).toEqual(["companies", "users"]);
  });

  it("exposes company_id, not tenantId", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
      ORDER BY column_name
    `;

    const names = columns.map((c) => c.column_name);
    expect(names).toContain("company_id");
    expect(names).not.toContain("tenantId");
  });
});
