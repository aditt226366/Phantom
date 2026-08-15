import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../scripts/db-urls.mjs";

/**
 * Every timestamp column stores an instant, not a wall clock.
 *
 * Prisma maps DateTime to `timestamp(3) WITHOUT time zone` by default. That
 * column stores digits with no offset attached, and the ORM is self-consistent
 * about them, so nothing goes wrong until somebody writes raw SQL - at which
 * point binding a Date and casting `::timestamp` keeps the digits and discards
 * the offset, writing a value out by the node process's UTC offset. `now()`
 * fails the same way through the session's TimeZone. Both produce rows that
 * look entirely plausible and are wrong by hours.
 *
 * 20260816090000 converted all 64 columns to timestamptz(3), which removes the
 * wall clock and with it the whole class of mistake. This test is what keeps it
 * removed: a `DateTime` field added without `@db.Timestamptz(3)` reintroduces a
 * naive column silently, since the generated migration looks like every other
 * column addition and nothing else in the suite would notice.
 *
 * The allowlist is empty and is meant to stay empty. It exists rather than
 * being written as "no matches" so that an exception, if one is ever genuinely
 * needed, has somewhere to be argued for and a reason attached - the shape
 * GLOBAL_TABLES and the raw-SQL allowlist both use. A naive column is a
 * decision, not an accident, or it is a bug.
 */
const NAIVE_COLUMNS_ALLOWED = new Map<string, string>([
  /*
   * Nothing. A local wall clock with no zone is only correct for a value that
   * genuinely has no instant - a birthday, an opening time - and this schema
   * has none. If one arrives, name it here with the reason it is not an
   * instant, and expect to be asked.
   */
]);

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
    const naive = await timestampColumns(false);

    expect(
      naive.sort(),
      "a DateTime field is missing @db.Timestamptz(3) — it stores a wall clock " +
        "with no offset, and raw SQL touching it needs an explicit cast to stay " +
        "correct. Add the attribute and an ALTER ... TYPE timestamptz(3) USING " +
        "col AT TIME ZONE 'UTC', or name the column in NAIVE_COLUMNS_ALLOWED " +
        "with the reason it holds no instant",
    ).toEqual([...NAIVE_COLUMNS_ALLOWED.keys()].sort());
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
