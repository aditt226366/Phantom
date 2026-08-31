import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../scripts/db-urls.mjs";
import { checkTimestampColumns } from "../scripts/invariants.mjs";


/** Prisma's own bookkeeping table, which it owns and already stores as tz. */
const NOT_OURS = new Set(["_prisma_migrations"]);

let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: testDatabaseUrl() });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

async function timestampColumns(withTimeZone: boolean): Promise<string[]> {
  const { rows } = await db.query<{ entry: string }>(
    `SELECT table_name || '.' || column_name AS entry
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = $1
      ORDER BY entry`,
    [withTimeZone ? "timestamp with time zone" : "timestamp without time zone"],
  );

  return rows
    .map((r) => r.entry)
    .filter((entry) => !NOT_OURS.has(entry.split(".")[0]!));
}

describe("timestamp columns", () => {
  it("found columns to check", async () => {
    /*
     * The guard against a query that silently matches nothing - which would
     * make the assertion below pass for the worst possible reason.
     */
    expect((await timestampColumns(true)).length).toBeGreaterThan(50);
  });

  it("are all timestamptz, with no exceptions", async () => {
    /*
     * Runs from scripts/invariants.mjs, the same implementation
     * `npm run db:verify` points at another database - so a green suite and a
     * clean report about dev or production mean the same thing.
     */
    expect(
      await checkTimestampColumns(db),
      "a DateTime field is missing @db.Timestamptz(3), or a timestamptz is not (3)",
    ).toEqual([]);
  });

  it("keeps millisecond precision, matching Prisma's DateTime", async () => {
    /*
     * The other half of the mapping, and it is not cosmetic. A bare timestamptz
     * keeps microseconds; Prisma's DateTime is milliseconds, so a value written
     * by raw SQL would round-trip through the ORM losing digits it can neither
     * see nor preserve - and an equality comparison between a stored value and
     * the Date that wrote it would start failing for sub-millisecond reasons.
     */
    const { rows } = await db.query<{ entry: string; scale: number | null }>(
      `SELECT table_name || '.' || column_name AS entry, datetime_precision AS scale
         FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
        ORDER BY entry`,
    );

    const wrong = rows
      .filter((r) => !NOT_OURS.has(r.entry.split(".")[0]!))
      .filter((r) => r.scale !== 3)
      .map((r) => `${r.entry} (precision ${r.scale})`);

    expect(wrong, "timestamptz columns that are not (3)").toEqual([]);
  });

  it("round-trips an instant through raw SQL with no cast at all", async () => {
    /*
     * The property the migration bought, asserted rather than assumed - and
     * asserted the way the bug would have appeared: bind a Date, read it back,
     * compare instants. Against a naive column this returns a value offset by
     * the client's timezone, which is exactly what nobody noticed for 64
     * columns until raw SQL was written against one.
     */
    const instant = new Date("2026-08-15T12:34:56.789Z");

    const { rows } = await db.query<{ out: Date }>(
      `SELECT $1::timestamptz(3) AS out`,
      [instant],
    );

    expect(rows[0]?.out.toISOString()).toBe(instant.toISOString());
  });
});
