import { companyFilterSchema, safeParseInput } from "@whatsapp-os/core";
import { createCompany, newCompanyId, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { listCompanies } from "@/lib/admin-db";
import { formatTimestamp } from "@/lib/format";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The companies list: filtered in the database, paged from the URL.
 */

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "users", "companies" RESTART IDENTITY CASCADE`,
    ),
  );
});

let seq = 0;

async function seed(options: {
  name: string;
  owner: string;
  deactivated?: boolean;
  lastLoginAt?: Date | null;
}): Promise<string> {
  const id = newCompanyId();
  seq += 1;

  await withCompany(id, async (db, companyId) => {
    await createCompany(db, companyId, options.name);
    await db.user.create({
      data: {
        companyId,
        fullName: options.owner,
        email: `${options.owner}@example.test`,
        username: options.owner,
        passwordHash: "$argon2id$placeholder",
        phoneE164: `+91987654${String(3000 + seq)}`,
        role: "OWNER",
        ...(options.lastLoginAt ? { lastLoginAt: options.lastLoginAt } : {}),
      },
    });
  });

  if (options.deactivated) {
    await superuser((client) =>
      client.query(`UPDATE companies SET deactivated_at = now() WHERE id = $1`, [
        id,
      ]),
    );
  }

  return id;
}

describe("an installation with no companies", () => {
  it("returns an empty page that is not marked filtered", async () => {
    /*
     * The distinction the two empty states rest on. Unfiltered and empty means
     * "nothing here yet"; the page uses this flag to decide which story to
     * tell, and getting it wrong tells a new operator the platform has no
     * customers when their filter simply excluded them.
     */
    const page = await listCompanies({ status: "all", limit: 25 });

    expect(page.companies).toEqual([]);
    expect(page.filtered).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("search", () => {
  beforeEach(async () => {
    await seed({ name: "Analytical Engines", owner: "ada_l" });
    await seed({ name: "Beta Works", owner: "grace_h" });
  });

  it("matches the company name, case-insensitively", async () => {
    const page = await listCompanies({ status: "all", limit: 25, q: "analytical" });

    expect(page.companies.map((c) => c.name)).toEqual(["Analytical Engines"]);
    expect(page.filtered).toBe(true);
  });

  it("matches a fragment in the middle of the name", async () => {
    /* The leading-wildcard case the comment in admin-db.ts is about. */
    const page = await listCompanies({ status: "all", limit: 25, q: "gine" });

    expect(page.companies.map((c) => c.name)).toEqual(["Analytical Engines"]);
  });

  it("matches the owner's username", async () => {
    const page = await listCompanies({ status: "all", limit: 25, q: "grace" });

    expect(page.companies.map((c) => c.name)).toEqual(["Beta Works"]);
  });

  it("matches the slug even though the slug is not returned", async () => {
    const slug = await superuser(async (client) => {
      const { rows } = await client.query<{ slug: string }>(
        `SELECT slug FROM companies WHERE name = 'Beta Works'`,
      );
      return rows[0]!.slug;
    });

    const page = await listCompanies({ status: "all", limit: 25, q: slug });

    expect(page.companies.map((c) => c.name)).toEqual(["Beta Works"]);
    expect(page.companies[0]).not.toHaveProperty("slug");
  });

  it("returns an empty page marked filtered when nothing matches", async () => {
    const page = await listCompanies({
      status: "all",
      limit: 25,
      q: "no-such-company",
    });

    expect(page.companies).toEqual([]);
    expect(page.filtered).toBe(true);
  });
});

describe("status filter", () => {
  beforeEach(async () => {
    await seed({ name: "Live Co", owner: "live_owner" });
    await seed({ name: "Suspended Co", owner: "susp_owner", deactivated: true });
  });

  it("shows both by default", async () => {
    const page = await listCompanies({ status: "all", limit: 25 });

    expect(page.companies).toHaveLength(2);
    expect(page.filtered).toBe(false);
  });

  it("narrows to active", async () => {
    const page = await listCompanies({ status: "active", limit: 25 });

    expect(page.companies.map((c) => c.name)).toEqual(["Live Co"]);
    expect(page.companies[0]?.status).toBe("ACTIVE");
    expect(page.filtered).toBe(true);
  });

  it("narrows to deactivated", async () => {
    const page = await listCompanies({ status: "deactivated", limit: 25 });

    expect(page.companies.map((c) => c.name)).toEqual(["Suspended Co"]);
    expect(page.companies[0]?.status).toBe("DEACTIVATED");
  });

  it("combines with a search rather than replacing it", async () => {
    const page = await listCompanies({
      status: "deactivated",
      limit: 25,
      q: "co",
    });

    expect(page.companies.map((c) => c.name)).toEqual(["Suspended Co"]);
  });
});

describe("paging", () => {
  beforeEach(async () => {
    for (let index = 0; index < 5; index++) {
      await seed({ name: `Company ${index}`, owner: `owner_${index}` });
    }
  });

  it("returns a cursor only when there is more", async () => {
    const first = await listCompanies({ status: "all", limit: 2 });

    expect(first.companies).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const last = await listCompanies({ status: "all", limit: 25 });
    expect(last.companies).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });

  it("does not repeat a row across pages", async () => {
    const first = await listCompanies({ status: "all", limit: 2 });
    const second = await listCompanies({
      status: "all",
      limit: 2,
      cursor: first.nextCursor!,
    });

    const ids = [...first.companies, ...second.companies].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("walks the whole list without gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof listCompanies>> =
        await listCompanies({
          status: "all",
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });

      seen.push(...page.companies.map((c) => c.name));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe("the filter schema", () => {
  it("caps the limit, so a hand-edited URL cannot ask for everything", () => {
    const parsed = safeParseInput(companyFilterSchema, { limit: "100000" });

    expect(parsed.ok).toBe(false);
  });

  it("defaults to an unfiltered first page", () => {
    const parsed = safeParseInput(companyFilterSchema, {});

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toEqual({ status: "all", limit: 25 });
  });

  it("rejects a status it does not know", () => {
    const parsed = safeParseInput(companyFilterSchema, { status: "archived" });

    expect(parsed.ok).toBe(false);
  });
});

describe("last login", () => {
  it("renders in the platform's zone, to the second", async () => {
    /*
     * 15 August 2026, 05:30 UTC, which is 11:00 IST. Rendering this in the
     * server's zone would put it five and a half hours away from the "today"
     * boundary shown on the overview, with neither figure labelled.
     */
    await seed({
      name: "Timed Co",
      owner: "timed_owner",
      lastLoginAt: new Date("2026-08-15T05:30:00.000Z"),
    });

    const page = await listCompanies({ status: "all", limit: 25 });

    expect(formatTimestamp(page.companies[0]!.ownerLastLoginAt)).toBe(
      "15/08/2026 11:00:00",
    );
  });

  it("says Never for an owner who has not signed in", async () => {
    await seed({ name: "Fresh Co", owner: "fresh_owner" });

    const page = await listCompanies({ status: "all", limit: 25 });

    expect(page.companies[0]?.ownerLastLoginAt).toBeNull();
    expect(formatTimestamp(page.companies[0]!.ownerLastLoginAt)).toBe("Never");
  });
});
