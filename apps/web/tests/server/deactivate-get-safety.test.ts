import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpSchema } from "@whatsapp-os/core";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCompanyDetail } from "@/lib/admin-db";
import { signUp } from "@/lib/auth/signup";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Rendering the confirmation must not perform the act.
 *
 * A URL that deactivates on GET is reachable without anybody clicking it: a
 * browser preloading a hovered link, a mail client scanning an alert, a
 * corporate proxy fetching every URL it sees. The reset-token prefetch problem
 * from earlier in this phase, except the consequence is a paying customer
 * losing access to their account.
 *
 * So the page is asserted two ways — by rendering it with every parameter set
 * and checking the database is unchanged, and at source level, because the
 * first check would still pass if somebody later moved the mutation into a
 * route handler.
 */

/*
 * The page reads cookies through requireAdminSession(), which needs a request
 * scope Vitest has no way to provide. Mocked to a signed-in operator: this
 * test is about what a GET *writes*, and an authenticated caller is the
 * strongest version of the question.
 */
vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => ({
    sessionId: "session",
    adminUserId: "admin",
    username: "operator",
    csrfSecret: "csrf",
  }),
  assertAdminCsrf: async () => undefined,
}));

vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: undefined, userAgent: undefined }),
}));

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const companyRoute = join(
  webRoot,
  "app",
  "(admin)",
  "admin",
  "(console)",
  "companies",
  "[id]",
);

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

let companyId: string;

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "sessions", "audit_log", "users", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );

  const signup = await signUp(
    signUpSchema.parse({
      fullName: "Ada Lovelace",
      companyName: "Analytical Engines",
      email: "ada@example.test",
      phone: "9876543210",
      username: "ada_l",
      password: "a-sufficiently-long-password",
      confirmPassword: "a-sufficiently-long-password",
    }),
    {},
  );
  if (!signup.ok) throw new Error("signup failed");

  companyId = signup.value.companyId;
});

describe("rendering the confirmation page", () => {
  it("changes nothing, with every parameter set", async () => {
    /*
     * The page is the GET. Calling its default export is what a request does,
     * and the assertion is that the company is exactly as it was afterwards.
     */
    const { default: CompanyOverviewPage } = await import(
      "@/app/(admin)/admin/(console)/companies/[id]/page"
    );

    const before = await getCompanyDetail(companyId);
    expect(before?.status).toBe("ACTIVE");

    await CompanyOverviewPage({
      params: Promise.resolve({ id: companyId }),
      searchParams: Promise.resolve({
        confirm: "deactivate",
        /* Everything a hopeful attacker might add. */
        deactivate: "true",
        confirmed: "yes",
        companyId,
      }),
    });

    const after = await getCompanyDetail(companyId);

    expect(after?.status).toBe("ACTIVE");
    expect(after?.deactivatedAt).toBeNull();
  });

  it("changes nothing for the reactivate intent either", async () => {
    const { default: CompanyOverviewPage } = await import(
      "@/app/(admin)/admin/(console)/companies/[id]/page"
    );

    await superuser((client) =>
      client.query(`UPDATE companies SET deactivated_at = now() WHERE id = $1`, [
        companyId,
      ]),
    );

    await CompanyOverviewPage({
      params: Promise.resolve({ id: companyId }),
      searchParams: Promise.resolve({ confirm: "reactivate" }),
    });

    expect((await getCompanyDetail(companyId))?.status).toBe("DEACTIVATED");
  });
});

describe("the route tree", () => {
  /** Every file under the company workspace, so a new one cannot slip past. */
  function routeFiles(): string[] {
    const found: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) found.push(full);
      }
    }

    walk(companyRoute);
    return found;
  }

  it("has no GET route handler that could mutate", () => {
    /*
     * A route.ts exporting GET is the other way this becomes reachable, and it
     * would sail past the render check above.
     */
    const handlers = routeFiles().filter((file) =>
      /[/\\]route\.tsx?$/.test(file),
    );

    expect(handlers).toEqual([]);
  });

  it("never calls the deactivation writer from a page", () => {
    /* Pages render. The write lives in a server action, reached by a POST. */
    for (const file of routeFiles()) {
      expect(readFileSync(file, "utf8"), file).not.toContain(
        "setCompanyDeactivated",
      );
    }
  });
});

describe("the deactivation actions", () => {
  it("assert CSRF before writing", () => {
    const source = readFileSync(
      join(webRoot, "app", "(admin)", "admin", "actions.ts"),
      "utf8",
    );

    const body = source.slice(source.indexOf("async function setDeactivation"));
    const csrfAt = body.indexOf("assertAdminCsrf");
    const writeAt = body.indexOf("setCompanyDeactivated");

    expect(csrfAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(csrfAt, "CSRF is checked after the write").toBeLessThan(writeAt);
  });

  it("are submitted by a form, never linked", () => {
    const header = readFileSync(
      join(webRoot, "app", "(admin)", "admin", "_components", "company-header.tsx"),
      "utf8",
    );

    /* The confirm link is a Link; the act is a form action. */
    expect(header).toMatch(/<form\s+action=\{[\s\S]*?deactivateCompanyAction/);
    expect(header).not.toMatch(/href=\{[^}]*deactivateCompanyAction/);
  });
});
