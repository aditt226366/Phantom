import { describe, expect, it } from "vitest";

import {
  RUN_STATUS_ORDER,
  inRunStatusOrder,
  runStatusLabel,
} from "../../lib/flow-display.ts";

/**
 * The order the run-state chips are read in.
 *
 * ---------------------------------------------------------------------------
 * Why this file starts with an ordering rather than a label
 * ---------------------------------------------------------------------------
 *
 * The chips came out of a `groupBy` with no `orderBy` at all, so their order
 * was whatever the aggregate hashed to. That is not a stable thing to be: the
 * screenshot suite photographed them reading "In progress, Waiting to resume,
 * Finished, Handed to a person" for two phases, and then the same page, the
 * same rows and the same query produced "Handed to a person" first.
 *
 * A page that reorders itself between two loads is a small bug with an
 * expensive shape - the reader's eye learns a position, and the position is
 * not real. It is the same fault as the five dashboard lists, one layer up:
 * there, the database was asked for an order it could not give; here it was
 * not asked at all, because a lifecycle is not something a column knows.
 *
 * So the order is declared beside the label and the colour, and this asserts
 * it survives contact with rows arriving in any order.
 */

/** Rows shaped like the groupBy result, deliberately in the wrong order. */
const SHUFFLED = [
  { status: "FAILED" as const, count: 2 },
  { status: "HANDED_OFF" as const, count: 1 },
  { status: "ACTIVE" as const, count: 7 },
  { status: "COMPLETED" as const, count: 4 },
  { status: "PAUSED" as const, count: 3 },
];

describe("the run states have a reading order", () => {
  it("is the lifecycle, not the alphabet", () => {
    /*
     * Stated as a literal, because the point is the sentence it makes: what is
     * happening now, what is waiting, what finished, what left, what broke.
     *
     * `ORDER BY status` would have spelled it Active, Completed, Failed,
     * Handed off, Paused - which is a correct total order and reads as
     * nothing at all. That is why this is not solved in the query.
     */
    expect(RUN_STATUS_ORDER).toEqual([
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "HANDED_OFF",
      "FAILED",
    ]);
  });

  it("puts rows in that order however they arrive", () => {
    expect(inRunStatusOrder(SHUFFLED).map((row) => row.status)).toEqual([
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "HANDED_OFF",
      "FAILED",
    ]);
  });

  it("keeps the counts attached to their own state", () => {
    /*
     * The failure a bare order assertion would miss. Sorting the labels while
     * the numbers stay put is a page that says "In progress: 2" about the two
     * runs that failed, and it looks entirely normal.
     */
    expect(inRunStatusOrder(SHUFFLED)).toEqual([
      { status: "ACTIVE", count: 7 },
      { status: "PAUSED", count: 3 },
      { status: "COMPLETED", count: 4 },
      { status: "HANDED_OFF", count: 1 },
      { status: "FAILED", count: 2 },
    ]);
  });

  it("does not mutate what it was given", () => {
    /* The counts come straight from a loader's return value. Sorting in place
       would reorder the caller's array as a side effect of rendering. */
    const rows = [...SHUFFLED];
    inRunStatusOrder(rows);

    expect(rows.map((row) => row.status)).toEqual(
      SHUFFLED.map((row) => row.status),
    );
  });

  it("orders a partial result without inventing the missing states", () => {
    /*
     * The ordinary case: a flow nobody has failed has four groups, not five.
     * A ranking that filled the gaps would render "Stopped: 0" on every page
     * and turn an empty state into a permanent nil report.
     */
    const partial = SHUFFLED.filter((row) => row.status !== "FAILED");

    expect(inRunStatusOrder(partial).map((row) => row.status)).toEqual([
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "HANDED_OFF",
    ]);
  });

  it("gives every ordered state a label, so no chip can render blank", () => {
    /*
     * The two lists are maintained separately - one is a Record the compiler
     * checks, the other a switch - and this is the seam between them. A state
     * with a rank and no label renders an empty chip beside a number.
     */
    for (const status of RUN_STATUS_ORDER) {
      expect(runStatusLabel(status), status).toMatch(/\S/);
    }
  });
});
