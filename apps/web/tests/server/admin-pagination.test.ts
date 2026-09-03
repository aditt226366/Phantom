import { createCompany, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { listCompanies } from "@/lib/admin-db";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Paging the admin company list across a tie.
 *
 * ---------------------------------------------------------------------------
 * Why a tie is worse under keyset pagination than under a plain LIMIT
 * ---------------------------------------------------------------------------
 *
 * A plain `LIMIT` over a tied `ORDER BY` returns six of the eight tied rows and
 * no two runs need agree on which six - bad, but at least self-contained.
 *
 * Keyset pagination compounds it. The next page is "everything after the cursor
 * row IN THIS ORDERING", so if the ordering does not place the cursor row
 * uniquely, the rows tied with it have no defined side of the boundary. They
 * can land on both pages, or on neither. `listCompanies` ordered on
 * `created_at` alone with `cursor: { id }` and `skip: 1`, which is exactly that
 * shape.
 *
 * The tie is not contrived. Companies arrive in batches - a seed, an import, a
 * migration - and share a `created_at`. An operator paging the list would
 * simply never be shown a customer, and nothing on the screen would say so:
 * every page is full, and the missing company is missing from the only place
 * anybody would look for it.
 *
 * So the assertion is not "the pages are in the right order". It is that
 * paging to the end yields every company exactly once.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THIS FILE: it does not fail without the fix
 * ---------------------------------------------------------------------------
 *
 * Measured, not assumed. Removing the `{ id: "desc" }` tiebreak from
 * listCompanies leaves both tests below green.
 *
 * The reason is that the fault needs the tie to be resolved DIFFERENTLY between
 * the query for page one and the query for page two. Six rows in a freshly
 * truncated table give Postgres one plan and one physical order, so it answers
 * both queries identically and the paging is accidentally self-consistent. The
 * bug is real - it just needs a plan change, a concurrent write, or an
 * autovacuum between two page loads, none of which a fixture can force
 * honestly.
 *
 * The regression guard for this call site is therefore
 * `packages/core/tests/total-ordering.test.ts`, which reads the ordering off
 * the source and DOES fail when the tiebreak is removed - verified by removing
 * it. What this file contributes is the statement of the property in
 * executable form, and a place for a reproduction to land if anyone ever
 * manages to force one.
 *
 * It is left here deliberately rather than deleted, and labelled rather than
 * left looking like evidence. A green test that cannot fail is the shape this
 * repository has been caught by before - a requirements table whose evidence
 * was a constant, asserted about nothing.
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

/** One instant for every company, which is what a batched arrival looks like. */
const TIED = new Date("2026-09-08T10:00:00.000Z");

const COUNT = 6;
const PAGE = 2;

/**
 * Ids whose ascending order is the REVERSE of the order the rows are written.
 *
 * Without this the test could pass on a plan that happens to return rows
 * physically: cuids are roughly monotonic, so natural ids and insertion order
 * agree, and the tiebreak would be indistinguishable from no tiebreak.
 */
const IDS = Array.from(
  { length: COUNT },
  (_, i) => `cmp-${String(COUNT - 1 - i).padStart(3, "0")}`,
);

beforeEach(async () => {
  await superuser((client) =>
    client.query(`TRUNCATE TABLE "users", "companies" RESTART IDENTITY CASCADE`),
  );

  for (const [i, id] of IDS.entries()) {
    await withCompany(id, async (db, companyId) => {
      await createCompany(db, companyId, `Company ${i}`);
    });
  }

  /* Tied afterwards rather than at insert: created_at defaults to now() and
     createCompany does not take one. The tie is the fixture. */
  await superuser((client) =>
    client.query(`UPDATE companies SET created_at = $1`, [TIED]),
  );
});

describe("paging a list of companies that all arrived together", () => {
  it("shows every company exactly once across the pages", async () => {
    /*
     * THE assertion. Not the order of the pages - which company is on which
     * page is uninteresting - but that paging to the end is a partition of the
     * companies: none skipped, none repeated.
     */
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < COUNT; page += 1) {
      const result = await listCompanies({
        status: "all",
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });

      seen.push(...result.companies.map((company) => company.id));

      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen.sort()).toEqual([...IDS].sort());
    expect(new Set(seen).size, "a company appeared on two pages").toBe(COUNT);
  });

  it("hands out pages in the declared order, newest id first within the tie", async () => {
    /*
     * The ordering half, stated separately so a failure says which of the two
     * properties broke. Every created_at is equal, so the whole list is decided
     * by the tiebreak - id descending, matching the created_at descending it
     * follows.
     */
    const first = await listCompanies({ status: "all", limit: PAGE });

    expect(first.companies.map((company) => company.id)).toEqual(
      [...IDS].sort().reverse().slice(0, PAGE),
    );
  });
});
