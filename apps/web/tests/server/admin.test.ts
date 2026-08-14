import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, hashToken, signUpSchema } from "@whatsapp-os/core";
import { prisma, withCompany } from "@whatsapp-os/db";
import {
  listCompanies,
  upsertAdminUser,
  writeAdminAudit,
  createAdminSessionRow,
  findAdminSessionByTokenHash,
} from "@/lib/admin-db";
import { resolveAdminSessionByToken } from "@/lib/auth/admin-session";
import { resolveSessionByToken } from "@/lib/auth/session-store";
import { safeNextPath } from "@/lib/auth/safe-next";
import { signUp } from "@/lib/auth/signup";
import { issueSessionToken, generateCsrfSecret } from "@whatsapp-os/core";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

const raw = new pg.Pool({ connectionString: testSuperuserDatabaseUrl(), max: 2 });
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

afterAll(async () => {
  await raw.end();
});

async function truncateAll(): Promise<void> {
  const { rows } = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await raw.query(
    `TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

function tenantForm(overrides: Record<string, string> = {}) {
  return signUpSchema.parse({
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "ada@example.test",
    phone: "9876543210",
    username: "ada_l",
    password: "a-sufficiently-long-password",
    confirmPassword: "a-sufficiently-long-password",
    ...overrides,
  });
}

async function seedAdmin(username = "root") {
  const { id } = await upsertAdminUser(
    username,
    await hashPassword("an-admin-password-here"),
  );
  const { token, tokenHash, expiresAt } = issueSessionToken();
  await createAdminSessionRow({
    adminUserId: id,
    tokenHash,
    csrfSecret: generateCsrfSecret(),
    expiresAt,
  });
  return { adminUserId: id, token };
}

beforeEach(async () => {
  await truncateAll();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
});

describe("the two account spaces do not overlap", () => {
  it("does not resolve an admin token as a tenant session", async () => {
    const admin = await seedAdmin();

    /*
     * The admin token is a valid credential — in the other space. Presented as
     * a tenant cookie it resolves to nothing, because the lookup is a different
     * table entirely and app_resolve_company only knows about rows carrying a
     * company_id.
     */
    expect(await resolveSessionByToken(admin.token)).toBeNull();
  });

  it("does not resolve a tenant token as an admin session", async () => {
    const signup = await signUp(tenantForm(), {});
    if (!signup.ok) throw new Error("signup failed");

    expect(
      await resolveAdminSessionByToken(signup.value.sessionToken),
    ).toBeNull();
  });

  it("fails quietly rather than informatively", async () => {
    /*
     * Neither direction throws. An error that distinguished "no such session"
     * from "wrong kind of session" would confirm the token is real.
     */
    const admin = await seedAdmin();
    const signup = await signUp(tenantForm(), {});
    if (!signup.ok) throw new Error("signup failed");

    await expect(resolveSessionByToken(admin.token)).resolves.toBeNull();
    await expect(
      resolveAdminSessionByToken(signup.value.sessionToken),
    ).resolves.toBeNull();
    await expect(resolveAdminSessionByToken("garbage")).resolves.toBeNull();
  });

  it("keeps admin sessions out of app_resolve_company", async () => {
    const admin = await seedAdmin();
    const tokenHash = hashToken(admin.token);

    for (const kind of ["session", "username", "email", "verification"]) {
      const { rows } = await raw.query<{ company_id: string | null }>(
        "SELECT app_resolve_company($1, $2) AS company_id",
        [kind, tokenHash],
      );
      expect(rows[0]?.company_id, kind).toBeNull();
    }
  });

  it("denies app_runtime any access to the admin tables", async () => {
    /* Not a policy — an outright absence of grants, so RLS never applies. */
    for (const table of ["admin_users", "admin_sessions", "admin_audit_log"]) {
      await expect(
        prisma.$queryRawUnsafe(`SELECT * FROM ${table}`),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe("lockout scope", () => {
  it("keeps tenant and admin counters apart for the same username", async () => {
    /*
     * Before the scope column these shared a row, so failing a tenant sign-in
     * five times locked out the identically-named admin — and vice versa.
     */
    const ip = "203.0.113.10";

    await prisma.loginAttempt.create({
      data: { scope: "TENANT", username: "ada_l", ip, failureCount: 4 },
    });
    await prisma.loginAttempt.create({
      data: { scope: "ADMIN", username: "ada_l", ip, failureCount: 1 },
    });

    const rows = await prisma.loginAttempt.findMany({
      where: { username: "ada_l", ip },
      select: { scope: true, failureCount: true },
    });

    /*
     * Sorted here, not in the query: ordering by a Postgres enum sorts by
     * declaration order, not alphabetically, which makes the query's ordering
     * an implementation detail of the schema.
     */
    const byScope = Object.fromEntries(
      rows.map((row) => [row.scope, row.failureCount]),
    );

    expect(byScope).toEqual({ ADMIN: 1, TENANT: 4 });
  });
});

describe("listCompanies", () => {
  it("sees across tenants while app_runtime sees none", async () => {
    const first = await signUp(tenantForm(), {});
    const second = await signUp(
      tenantForm({
        username: "beta_owner",
        email: "beta@example.test",
        companyName: "Beta Works",
      }),
      {},
    );
    if (!first.ok || !second.ok) throw new Error("signup failed");

    const companies = await listCompanies();
    expect(companies).toHaveLength(2);
    expect(companies.map((c) => c.name).sort()).toEqual([
      "Analytical Engines",
      "Beta Works",
    ]);
    expect(companies.every((c) => c.userCount === 1)).toBe(true);

    /*
     * The same read through the tenant role, with no company context, returns
     * nothing. That contrast is the proof that app_admin's cross-tenant policy
     * is doing the work and not something incidental.
     */
    const throughRuntime = await prisma.company.findMany();
    expect(throughRuntime).toEqual([]);
  });

  it("returns a summary and no tenant content", async () => {
    const signup = await signUp(tenantForm(), {});
    if (!signup.ok) throw new Error("signup failed");

    const [company] = await listCompanies();

    /* Widening this is a change to lib/admin-db.ts, in review. */
    expect(Object.keys(company!).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "slug",
      "userCount",
    ]);
  });
});

describe("admin audit", () => {
  it("records an actor, an action and a time", async () => {
    const admin = await seedAdmin();

    await writeAdminAudit({
      adminUserId: admin.adminUserId,
      action: "admin.companies.list",
      ip: "203.0.113.5",
      metadata: { count: 2 },
    });

    const { rows } = await raw.query<{
      admin_user_id: string;
      action: string;
      ip: string;
      created_at: Date;
    }>("SELECT admin_user_id, action, ip, created_at FROM admin_audit_log");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.admin_user_id).toBe(admin.adminUserId);
    expect(rows[0]?.action).toBe("admin.companies.list");
    expect(rows[0]?.ip).toBe("203.0.113.5");
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it("never throws, so a log failure cannot break the operation", async () => {
    await expect(
      writeAdminAudit({ adminUserId: "does-not-exist", action: "x" }),
    ).resolves.toBeUndefined();
  });
});

describe("admin session lifecycle", () => {
  it("resolves, then stops resolving once revoked", async () => {
    const admin = await seedAdmin();

    expect(await resolveAdminSessionByToken(admin.token)).not.toBeNull();

    await raw.query("UPDATE admin_sessions SET revoked_at = now()");
    expect(await resolveAdminSessionByToken(admin.token)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const admin = await seedAdmin();
    await raw.query(
      "UPDATE admin_sessions SET expires_at = now() - interval '1 minute'",
    );
    expect(await resolveAdminSessionByToken(admin.token)).toBeNull();
  });

  it("stores only the hash of the token", async () => {
    const admin = await seedAdmin();
    const stored = await findAdminSessionByTokenHash(hashToken(admin.token));

    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).not.toBe(admin.token);
  });
});

describe("?next= validation", () => {
  it("rejects off-origin and protocol-relative destinations", () => {
    /*
     * The whole class: a naive startsWith("/") passes //evil.example, and
     * browsers normalise a backslash into the authority position.
     */
    for (const hostile of [
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "evil.example",
      "",
    ]) {
      expect(safeNextPath(hostile, "/admin", "/admin"), hostile).toBe("/admin");
    }
  });

  it("rejects a tenant path on the admin sign-in", () => {
    /* A crafted link must not bounce a fresh admin into the tenant app. */
    expect(safeNextPath("/dashboard", "/admin", "/admin")).toBe("/admin");
    expect(safeNextPath("/admin-other", "/admin", "/admin")).toBe("/admin");
  });

  it("accepts a genuine admin path", () => {
    expect(safeNextPath("/admin", "/admin", "/admin")).toBe("/admin");
    expect(safeNextPath("/admin/companies", "/admin", "/admin")).toBe(
      "/admin/companies",
    );
  });

  it("accepts a tenant path when unconstrained", () => {
    expect(safeNextPath("/dashboard", "/dashboard")).toBe("/dashboard");
    expect(safeNextPath("//evil.example", "/dashboard")).toBe("/dashboard");
  });
});

describe("the admin client has exactly one import site", () => {
  it("is only imported by lib/admin-db.ts", () => {
    /*
     * Enforced by lint in the next commit; asserted here because a test also
     * catches an eslint-disable, and because this is the invariant that keeps
     * the cross-tenant capability reviewable in one file.
     */
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs)$/.test(entry)) continue;

        const source = readFileSync(full, "utf8");

        /*
         * Import statements only, not any mention of the string. This file
         * names the specifier in order to search for it, and matching on a
         * bare substring made the check flag itself.
         */
        const imports =
          /(?:^|\n)\s*import[^;]*from\s+["']@whatsapp-os\/db\/admin["']/.test(
            source,
          ) || /require\(\s*["']@whatsapp-os\/db\/admin["']\s*\)/.test(source);

        if (!imports) continue;

        const rel = relative(webRoot, full).replace(/\\/g, "/");
        if (rel !== "lib/admin-db.ts") offenders.push(rel);
      }
    }

    walk(webRoot);
    expect(offenders).toEqual([]);
  });

  it("does not re-export the client", () => {
    const source = readFileSync(join(webRoot, "lib", "admin-db.ts"), "utf8");
    expect(source).not.toMatch(/export\s+\{[^}]*adminPrisma/);
    expect(source).not.toMatch(/export\s+.*\badminPrisma\b\s*=/);
  });
});

describe("every admin route guards itself", () => {
  it("calls requireAdminSession, never requireSession", () => {
    const page = readFileSync(
      join(webRoot, "app", "(admin)", "admin", "page.tsx"),
      "utf8",
    );

    expect(page).toContain("requireAdminSession");
    /* The tenant guard here would let a tenant session into the panel. */
    expect(page).not.toMatch(/\brequireSession\b/);
  });

  it("redirects to the admin sign-in, not the tenant one", () => {
    const source = readFileSync(
      join(webRoot, "lib", "auth", "admin-session.ts"),
      "utf8",
    );

    expect(source).toContain('redirect("/admin/sign-in")');
    expect(source).not.toMatch(/redirect\("\/sign-in"\)/);
  });
});
