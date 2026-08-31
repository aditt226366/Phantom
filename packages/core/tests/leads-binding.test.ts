import { describe, expect, it } from "vitest";
import {
  POLL_INTERVAL_DEFAULT_SECONDS,
  POLL_INTERVAL_MAX_SECONDS,
  POLL_INTERVAL_MIN_SECONDS,
  clampPollInterval,
  leadSourceActionSchema,
  parseLeadSourceAction,
  parseSheetRef,
  toRecords,
} from "../src/leads/index.ts";
import {
  ROW_HASH_VERSION,
  anchorHash,
  newRowsSince,
  rowHash,
} from "../src/leads/hash.ts";
import { buildAudience } from "../src/bulk/index.ts";

/**
 * The pure half of a lead source.
 *
 * Every assertion here stands for something that fails without an error
 * message: a cursor that never advances again, a hash that re-sends a whole
 * spreadsheet, a phone column read out of the wrong cell.
 */

describe("the sheet a tenant pasted", () => {
  it("reads the id out of an address-bar URL", () => {
    const result = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0",
    );

    expect(result).toEqual({
      ok: true,
      spreadsheetId: "1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789",
      gid: 0,
    });
  });

  it("keeps the gid from the fragment", () => {
    /* Which tab they were looking at when they copied the link is very often
       the tab they mean, and picking the wrong one imports a different list
       and reports no error at all. */
    const result = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=884",
    );

    expect(result.ok && result.gid).toBe(884);
  });

  it("keeps the gid from the query when that is where it is", () => {
    const result = parseSheetRef(
      "https://docs.google.com/spreadsheets/d/1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789/edit?gid=17",
    );

    expect(result.ok && result.gid).toBe(17);
  });

  it("accepts a bare id", () => {
    const result = parseSheetRef("1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789");

    expect(result.ok && result.spreadsheetId).toBe(
      "1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789",
    );
    expect(result.ok && result.gid).toBeNull();
  });

  it("names a Google Doc as a Google Doc", () => {
    /* "Requested entity was not found" is not a sentence anybody can act on. */
    const result = parseSheetRef(
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Google Doc");
  });

  it("tells a form owner to bind the responses sheet", () => {
    const result = parseSheetRef(
      "https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("responses");
  });

  it("refuses a link that is not on google.com", () => {
    const result = parseSheetRef(
      "https://docs.google.com.evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit",
    );

    expect(result.ok).toBe(false);
  });

  it("refuses an empty paste with an instruction", () => {
    const result = parseSheetRef("   ");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Paste");
  });
});

describe("the action", () => {
  const action = {
    kind: "TEMPLATE" as const,
    templateId: "tmpl_1",
    mapping: { phone: "Mobile", variables: { "1": "Name" } },
  };

  it("accepts a template action", () => {
    expect(leadSourceActionSchema.parse(action)).toEqual(action);
  });

  it("refuses a kind nobody declared", () => {
    /* The point of the discriminated field: an action the engine has no case
       for is unrepresentable rather than merely unhandled. */
    expect(
      leadSourceActionSchema.safeParse({ ...action, kind: "FLOW" }).success,
    ).toBe(false);
  });

  it("returns null for a config it cannot read rather than throwing", () => {
    /* A poll job that throws on every attempt is a binding nobody can even
       disable. Null is a state the report has a sentence for. */
    expect(parseLeadSourceAction({ kind: "TEMPLATE" })).toBeNull();
    expect(parseLeadSourceAction(null)).toBeNull();
    expect(parseLeadSourceAction(action)).toEqual(action);
  });
});

describe("the poll interval", () => {
  it("defaults to thirty seconds", () => {
    expect(POLL_INTERVAL_DEFAULT_SECONDS).toBe(30);
  });

  it("clamps into the bounds rather than refusing", () => {
    expect(clampPollInterval(1)).toBe(POLL_INTERVAL_MIN_SECONDS);
    expect(clampPollInterval(999_999)).toBe(POLL_INTERVAL_MAX_SECONDS);
    expect(clampPollInterval(45)).toBe(45);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampPollInterval(Number.NaN)).toBe(POLL_INTERVAL_DEFAULT_SECONDS);
  });
});

describe("the row hash", () => {
  it("is stable for the same person and the same message", () => {
    expect(rowHash("+919876543210", ["Asha"])).toBe(
      rowHash("+919876543210", ["Asha"]),
    );
  });

  it("does not depend on where the row sits in the sheet", () => {
    /*
     * The one that would be catastrophic. An insert at the top shifts every
     * row below it, and a position-sensitive hash would re-send the entire
     * sheet to everybody on it - thousands of real WhatsApp messages that
     * cannot be un-sent.
     *
     * Asserted through a whole sheet rather than on the signature, because
     * "the function takes no index" is a fact about today's arguments and this
     * is a fact about the outcome: after an insert at the top, exactly one
     * hash is new.
     */
    const hashesOf = (values: string[][]) =>
      toRecords(values).rows.map((row) =>
        rowHash(`+91987654${row["Mobile"]}`, [row["Name"] ?? ""]),
      );

    const before = hashesOf([
      ["Name", "Mobile"],
      ["Asha", "3210"],
      ["Ravi", "3211"],
    ]);

    const afterInsertAtTop = hashesOf([
      ["Name", "Mobile"],
      ["Nikhil", "3212"],
      ["Asha", "3210"],
      ["Ravi", "3211"],
    ]);

    expect(afterInsertAtTop.filter((h) => !before.includes(h))).toHaveLength(1);
    for (const hash of before) expect(afterInsertAtTop).toContain(hash);
  });

  it("separates fields unambiguously", () => {
    /*
     * A join on a separator makes ["a:b","c"] and ["a","b:c"] hash the same,
     * and these are cells out of somebody's spreadsheet - a name with a colon
     * in it is not exotic. Two different leads sharing a hash means the second
     * is never contacted, silently.
     */
    expect(rowHash("+911", ["a:b", "c"])).not.toBe(rowHash("+911", ["a", "b:c"]));
  });

  it("changes when the message would change", () => {
    expect(rowHash("+919876543210", ["Asha"])).not.toBe(
      rowHash("+919876543210", ["Ravi"]),
    );
  });

  it("changes when the recipient changes", () => {
    expect(rowHash("+919876543210", ["Asha"])).not.toBe(
      rowHash("+919876543211", ["Asha"]),
    );
  });

  it("carries its version, so a change of rule is legible rather than inferred", () => {
    /* Bumping this re-hashes every row of every bound sheet, and every one of
       them then looks new. The prefix does not prevent that; it makes the
       cause readable in a table instead of guessed at from the duplicates. */
    expect(ROW_HASH_VERSION).toBe("v1");
  });

  it("is a hex digest, which is what the unique index stores", () => {
    expect(rowHash("+919876543210", [])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("turning a sheet into records", () => {
  it("keys rows by their header", () => {
    const content = toRecords([
      ["Name", "Mobile"],
      ["Asha", "9876543210"],
    ]);

    expect(content.headers).toEqual(["Name", "Mobile"]);
    expect(content.rows).toEqual([{ Name: "Asha", Mobile: "9876543210" }]);
  });

  it("fills a ragged row rather than reading undefined into a variable", () => {
    /* Google trims trailing blanks per row, so a row whose last cell is empty
       comes back shorter than the header. */
    const content = toRecords([["Name", "Mobile", "City"], ["Asha"]]);

    expect(content.rows[0]).toEqual({ Name: "Asha", Mobile: "", City: "" });
  });

  it("drops a blank header", () => {
    const content = toRecords([["Name", "", "Mobile"], ["Asha", "x", "98765"]]);

    expect(content.headers).toEqual(["Name", "Mobile"]);
    expect(content.rows[0]).toEqual({ Name: "Asha", Mobile: "98765" });
  });

  it("keeps the first of two columns with the same name", () => {
    /* The one the mapping screen offered. Taking the last silently maps to a
       column the tenant did not choose. */
    const content = toRecords([
      ["Mobile", "Mobile"],
      ["first", "second"],
    ]);

    expect(content.headers).toEqual(["Mobile"]);
    expect(content.rows[0]).toEqual({ Mobile: "first" });
  });

  it("hands buildAudience exactly what it already takes", () => {
    /* The cleaning pipeline is reused, not reimplemented. If this shape ever
       stops matching, the two would drift and a lead source would clean its
       numbers differently from a bulk import of the same file. */
    const content = toRecords([
      ["Name", "Mobile"],
      ["Asha", "98765 43210"],
      ["Ravi", "not a number"],
    ]);

    const audience = buildAudience(content.rows, {
      phone: "Mobile",
      variables: { "1": "Name" },
    });

    expect(audience.recipients).toEqual([
      { phoneE164: "+919876543210", variables: ["Asha"] },
    ]);
    expect(audience.counts.invalid).toBe(1);
  });
});

describe("which rows are new", () => {
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ Mobile: String(from + i) }));

  /** The cursor a poll would have left behind after seeing all of `list`. */
  const cursorAfter = (list: Array<Record<string, string>>) => ({
    count: list.length,
    anchor: list.length > 0 ? anchorHash(list[list.length - 1]!) : null,
  });

  it("returns everything on a first poll", () => {
    const result = newRowsSince(rows(2), { count: 0, anchor: null });

    expect(result.rows).toHaveLength(2);
    expect(result.rescanned).toBe(false);
  });

  it("returns only the appended rows when the sheet was appended to", () => {
    /* The common shape, and the one worth optimising - a Google Form writes
       exactly this. Nine thousand rows with two new ones is two rows of work. */
    const before = rows(3);
    const after = [...before, { Mobile: "3" }, { Mobile: "4" }];

    const result = newRowsSince(after, cursorAfter(before));

    expect(result.rows).toEqual([{ Mobile: "3" }, { Mobile: "4" }]);
    expect(result.cursor.count).toBe(5);
    expect(result.rescanned).toBe(false);
  });

  it("returns nothing when the sheet has not changed", () => {
    const list = rows(5);

    expect(newRowsSince(list, cursorAfter(list)).rows).toEqual([]);
  });

  it("re-examines the whole sheet after a deletion instead of going blind", () => {
    /*
     * The fault a bare count produces, and it produces it silently:
     *
     *   100 rows, cursor 100 -> tenant deletes 10 -> 90 rows -> a lead
     *   arrives -> 91 rows -> slice(100) is empty, for ever.
     *
     * That binding never sends anything again. No error, the sheet is plainly
     * being read, and nobody attributes it to a deletion weeks earlier.
     */
    const before = rows(100);
    const after = rows(91, 9);

    const result = newRowsSince(after, cursorAfter(before));

    expect(result.rows).toHaveLength(91);
    expect(result.cursor.count).toBe(91);
    expect(result.rescanned).toBe(true);
  });

  it("re-examines the whole sheet after a row is inserted in the middle", () => {
    /*
     * The other direction, and the one a length check alone cannot see. The
     * sheet GREW, so a bare count happily returns the last row - which has
     * already been sent - while the genuinely new row above the cursor is
     * never looked at again.
     */
    const before = rows(3);
    const after = [{ Mobile: "new" }, ...before];

    const result = newRowsSince(after, cursorAfter(before));

    expect(result.rows).toHaveLength(4);
    expect(result.rescanned).toBe(true);
  });

  it("re-examines the whole sheet after a re-sort", () => {
    const before = rows(4);
    const after = [...before].reverse();

    expect(newRowsSince(after, cursorAfter(before)).rescanned).toBe(true);
  });

  it("goes back to the fast path on the very next poll after a rescan", () => {
    /* The rescan is a one-off, not a per-poll cost. The same poll leaves a
       fresh count and anchor behind it. */
    const before = rows(10);
    const after = rows(6, 4);

    const rescan = newRowsSince(after, cursorAfter(before));
    expect(rescan.rescanned).toBe(true);

    const next = newRowsSince([...after, { Mobile: "x" }], rescan.cursor);
    expect(next.rescanned).toBe(false);
    expect(next.rows).toEqual([{ Mobile: "x" }]);
  });

  it("rescans when an anchor was never recorded", () => {
    /* A binding whose cursor predates the anchor column. Guessing that the
       count is still sound is exactly the guess this design refuses. */
    const result = newRowsSince(rows(5), { count: 3, anchor: null });

    expect(result.rows).toHaveLength(5);
  });

  it("treats a nonsense count as the beginning", () => {
    expect(newRowsSince(rows(3), { count: Number.NaN, anchor: "x" }).rows).toHaveLength(3);
    expect(newRowsSince(rows(3), { count: -8, anchor: "x" }).rows).toHaveLength(3);
  });

  it("leaves a null anchor for an empty sheet rather than throwing", () => {
    const result = newRowsSince([], { count: 4, anchor: "x" });

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({ count: 0, anchor: null });
  });
});

describe("the anchor", () => {
  it("is not the row hash, so an edit to any cell moves it", () => {
    /*
     * The two answer different questions. rowHash asks whether this person has
     * already been sent this message and ignores unmapped cells on purpose;
     * the anchor asks whether the sheet is the one we left, and using rowHash
     * for it would make it blind to exactly the edits it watches for.
     */
    const row = { Mobile: "98765", Notes: "called" };

    expect(anchorHash(row)).not.toBe(anchorHash({ ...row, Notes: "no answer" }));
  });

  it("does not depend on key order", () => {
    /* toRecords builds keys in header order, and a tenant reordering columns
       must not be read as every row having changed. */
    expect(anchorHash({ a: "1", b: "2" })).toBe(anchorHash({ b: "2", a: "1" }));
  });

  it("separates key from value unambiguously", () => {
    expect(anchorHash({ ab: "c" })).not.toBe(anchorHash({ a: "bc" }));
  });
});
