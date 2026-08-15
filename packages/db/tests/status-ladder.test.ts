import {
  MESSAGE_STATUSES,
  statusRank,
  statusRankSqlCase,
} from "@whatsapp-os/core/whatsapp";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../scripts/db-urls.mjs";

/**
 * The ladder in @whatsapp-os/core, checked against the database it is used on.
 *
 * status.ts is careful to keep the rank as plain data so it can be rendered
 * into SQL, and it says a test asserts the rendering by executing it against
 * the database. Until this file that was not true - the assertion inspected the
 * string. The two were consistent, but nothing was checking the half that
 * matters, which is what Postgres does with the result.
 *
 * Two things, and both are the kind that only break when somebody adds a member
 * to one side:
 *
 *   the enum and the ladder name the same statuses, in the same order
 *   the CASE expression evaluates to the ranks it was rendered from
 *
 * A missing CASE arm is the failure worth naming. Postgres returns NULL for an
 * unmatched CASE with no ELSE, every comparison against NULL is NULL rather
 * than false, and a guard built on it silently stops matching - so a status
 * added to the database but not to the ladder would not throw anywhere. It
 * would quietly stop advancing.
 */

let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: testDatabaseUrl() });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

describe("the delivery ladder and the message_status type", () => {
  it("name the same statuses, in the same order", async () => {
    const { rows } = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'message_status'
        ORDER BY e.enumsortorder`,
    );

    /*
     * Order included, not just membership. The database never sorts on this
     * type - the authority for the ordering is MESSAGE_STATUS_RANK - so a
     * disagreement is harmless the day it lands and misleading for ever
     * afterwards, because \dT+ is what somebody reads at 3am instead of the
     * TypeScript.
     */
    expect(
      rows.map((r) => r.label),
      "message_status and MESSAGE_STATUSES have diverged",
    ).toEqual([...MESSAGE_STATUSES]);
  });

  it("agree on every rank when Postgres evaluates the CASE", async () => {
    /*
     * Executed rather than parsed. The rendering is straightforward and the
     * thing that goes wrong is not the string - it is a member present in one
     * place and absent from the other, which produces a CASE that parses
     * perfectly and returns NULL for exactly one input.
     */
    const expression = statusRankSqlCase("status");

    const { rows } = await db.query<{ status: string; rank: number | null }>(
      `SELECT status, ${expression} AS rank
         FROM unnest($1::text[]) AS status`,
      [[...MESSAGE_STATUSES]],
    );

    expect(rows).toHaveLength(MESSAGE_STATUSES.length);

    for (const row of rows) {
      expect(row.rank, `${row.status} has no arm in the CASE`).not.toBeNull();
      expect(Number(row.rank), `${row.status} ranks differently in SQL`).toBe(
        statusRank(row.status as (typeof MESSAGE_STATUSES)[number]),
      );
    }
  });

  it("puts HELD below SENT, so a release is not read as a step backwards", async () => {
    /*
     * The one ordering decision this commit added, asserted where the SQL can
     * see it. Meta answers a send with held_for_quality_assessment and follows
     * it with an ordinary `sent` callback once the message is released; if HELD
     * outranked SENT the monotonic UPDATE would discard that callback.
     */
    const { rows } = await db.query<{ held: number; sent: number }>(
      `SELECT ${statusRankSqlCase("'HELD'")} AS held,
              ${statusRankSqlCase("'SENT'")} AS sent`,
    );

    expect(Number(rows[0]?.held)).toBeLessThan(Number(rows[0]?.sent));
  });
});
