import { describe, expect, it } from "vitest";
import { assertRuntimeRoleIsUnprivileged, prisma } from "../src/index.ts";

/**
 * The runtime role's privileges are a security boundary, not a config detail.
 *
 * Every isolation guarantee in this codebase rests on one assumption: the
 * connection the application uses is NOT the owner of the tables it queries,
 * because Postgres exempts owners from their own row-level security policies.
 * If that assumption ever quietly stops holding — someone points
 * DATABASE_URL_APP at the owner, a deploy script reuses the migration
 * credential — every RLS test in this repo keeps passing while enforcing
 * nothing. These tests are what make that impossible.
 */

const TENANT_TABLES = ["companies", "users"];

describe("runtime database role", () => {
  it("is app_runtime", async () => {
    const [row] = await prisma.$queryRaw<Array<{ current_user: string }>>`
      SELECT current_user
    `;

    expect(row?.current_user).toBe("app_runtime");
  });

  it("is neither superuser nor BYPASSRLS", async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });

  it("does not own any table it queries", async () => {
    const owned = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = current_user
    `;

    expect(owned).toEqual([]);
  });

  it("passes the startup assertion", async () => {
    await expect(assertRuntimeRoleIsUnprivileged()).resolves.toBeUndefined();
  });

  it.each(TENANT_TABLES)("can read and write %s", async (table) => {
    const grants = await prisma.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'app_runtime'
        AND table_schema = 'public'
        AND table_name = ${table}
    `;

    const held = grants.map((g) => g.privilege_type);
    expect(held).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
    );
  });

  it.each(TENANT_TABLES)("cannot TRUNCATE %s", async (table) => {
    /*
     * TRUNCATE ignores row-level security completely. Granting it would hand
     * app_runtime a one-statement bypass of every policy on the table.
     */
    const grants = await prisma.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'app_runtime'
        AND table_schema = 'public'
        AND table_name = ${table}
        AND privilege_type = 'TRUNCATE'
    `;

    expect(grants).toEqual([]);
  });
});
