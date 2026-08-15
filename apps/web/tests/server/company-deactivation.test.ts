import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCsrfSecret,
  hashPassword,
  issueSessionToken,
  signUpSchema,
} from "@whatsapp-os/core";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminSessionRow,
  getCompanyDetail,
  setCompanyDeactivated,
  upsertAdminUser,
} from "@/lib/admin-db";
import { issueAdminPasswordReset } from "@/lib/auth/admin-reset";
import { adminSignIn } from "@/lib/auth/admin-session";
import { resolveSessionByToken } from "@/lib/auth/session-store";
import { signIn } from "@/lib/auth/signin";
import { signUp } from "@/lib/auth/signup";
import { deactivationControl } from "@/app/(admin)/admin/_components/company-header";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Deactivation, from the operator's button down to the resolver.
 *
 * The two assertions the Phase 2 brief asked for are here: sign-in refuses,
 * and a session that was working a moment ago stops on its next request.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
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

let companyId: string;
let sessionToken: string;
/** A real admin row: the audit write has a foreign key, and it fails quietly. */
let adminUserId: string;

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "sessions", "password_reset_tokens", "audit_log",
                      "login_attempts", "admin_audit_log", "admin_sessions",
                      "admin_users", "users", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );

  const admin = await upsertAdminUser(
    "root",
    await hashPassword("an-admin-password-here"),
  );
  adminUserId = admin.id;

  const { tokenHash, expiresAt } = issueSessionToken();
  await createAdminSessionRow({
    adminUserId,
    tokenHash,
    csrfSecret: generateCsrfSecret(),
    expiresAt,
  });

  const signup = await signUp(tenantForm(), {});
  if (!signup.ok) throw new Error("signup failed");

  companyId = signup.value.companyId;
  sessionToken = signup.value.sessionToken;
});

describe("a live company", () => {
  it("resolves its sessions and accepts sign-in", async () => {
    /*
     * Asserted before every deactivation test below, so a null afterwards is
     * deactivation and not a session that never worked.
     */
    expect(await resolveSessionByToken(sessionToken)).not.toBeNull();

    const result = await signIn({ username: "ada_l", password: "a-sufficiently-long-password" }, {});
    expect(result.ok).toBe(true);
  });
});

describe("deactivating a company", () => {
  it("refuses sign-in", async () => {
    await setCompanyDeactivated(companyId, true);

    const result = await signIn({ username: "ada_l", password: "a-sufficiently-long-password" }, {});

    expect(result.ok).toBe(false);
  });

  it("stops an existing session on its next request", async () => {
    /*
     * Not at expiry — on the next request. app_resolve_company() joins
     * companies and returns NULL for a deactivated one, so the session lookup
     * finds nothing however long the cookie has left.
     */
    expect(await resolveSessionByToken(sessionToken)).not.toBeNull();

    await setCompanyDeactivated(companyId, true);

    expect(await resolveSessionByToken(sessionToken)).toBeNull();
  });

  it("is visible in the company workspace", async () => {
    await setCompanyDeactivated(companyId, true);

    const company = await getCompanyDetail(companyId);

    expect(company?.status).toBe("DEACTIVATED");
    expect(company?.deactivatedAt).not.toBeNull();
  });

  it("reports whether it changed anything", async () => {
    expect(await setCompanyDeactivated(companyId, true)).toBe(true);
    /* Already deactivated: no second audit row claiming it happened again. */
    expect(await setCompanyDeactivated(companyId, true)).toBe(false);
  });
});

describe("reactivating a company", () => {
  it("lets sign-in work again", async () => {
    await setCompanyDeactivated(companyId, true);
    expect((await signIn({ username: "ada_l", password: "a-sufficiently-long-password" }, {})).ok).toBe(
      false,
    );

    await setCompanyDeactivated(companyId, false);

    expect((await signIn({ username: "ada_l", password: "a-sufficiently-long-password" }, {})).ok).toBe(
      true,
    );
  });

  it("clears the deactivated timestamp", async () => {
    await setCompanyDeactivated(companyId, true);
    await setCompanyDeactivated(companyId, false);

    const company = await getCompanyDetail(companyId);

    expect(company?.status).toBe("ACTIVE");
    expect(company?.deactivatedAt).toBeNull();
  });

  it("is what the header offers once a company is deactivated", () => {
    /*
     * Without a way back, a misclick is recoverable only by hand-written SQL
     * against production. Asserted as a branch rather than as a substring:
     * the first version of this checked that the file mentioned "Reactivate"
     * somewhere, and stayed green when the control was removed because the
     * word survived in a neighbouring heading.
     */
    expect(deactivationControl("DEACTIVATED")).toEqual({
      intent: "reactivate",
      label: "Reactivate",
      submitLabel: "Reactivate company",
    });
  });

  it("is not what it offers for a live one", () => {
    expect(deactivationControl("ACTIVE")).toEqual({
      intent: "deactivate",
      label: "Deactivate",
      submitLabel: "Deactivate company",
    });
  });
});

describe("the password reset control", () => {
  it("refuses for a deactivated company, even called directly", async () => {
    /*
     * The button is hidden, but hiding is not refusing. app_resolve_company()
     * returns NULL for the 'password_reset' kind once a company is suspended,
     * so a link issued here could never be used — and the operator, told "a
     * link was sent", would go and debug the mail server.
     */
    await setCompanyDeactivated(companyId, true);

    const result = await issueAdminPasswordReset(adminUserId, "ada_l");

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("company-deactivated");
    expect(result.token).toBeUndefined();
  });

  it("mints no reset token at all", async () => {
    await setCompanyDeactivated(companyId, true);
    await issueAdminPasswordReset(adminUserId, "ada_l");

    const rows = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM password_reset_tokens WHERE company_id = $1`,
        [companyId],
      );
      return rows;
    });

    expect(rows).toEqual([]);
  });

  it("records the refusal, so the attempt is not invisible", async () => {
    await setCompanyDeactivated(companyId, true);
    await issueAdminPasswordReset(adminUserId, "ada_l");

    const rows = await superuser(async (client) => {
      const { rows } = await client.query<{ action: string }>(
        `SELECT action FROM admin_audit_log`,
      );
      return rows.map((row) => row.action);
    });

    expect(rows).toContain("admin.password_reset.refused_deactivated");
  });

  it("still works for a live company", async () => {
    const result = await issueAdminPasswordReset(adminUserId, "ada_l");

    expect(result.ok).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.refused).toBeUndefined();
  });

  it("is not offered in the header while deactivated", () => {
    const header = readFileSync(
      join(webRoot, "app", "(admin)", "admin", "_components", "company-header.tsx"),
      "utf8",
    );

    /* The reason is shown rather than the control being silently absent. */
    expect(header).toContain("Unavailable while this company is deactivated");
  });
});

describe("the admin account space is unaffected", () => {
  it("does not deactivate platform admins along with a tenant", async () => {
    /* Rule 5: separate tables, separate lifecycle. Nothing about a company's
       state should reach the panel's own credentials. */
    await setCompanyDeactivated(companyId, true);

    const result = await adminSignIn("nobody", "wrong-password", {});

    /* Refused because there is no such admin, not because of the company. */
    expect(result.ok).toBe(false);
  });
});
