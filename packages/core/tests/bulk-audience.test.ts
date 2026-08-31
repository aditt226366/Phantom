import { describe, expect, it } from "vitest";
import {
  buildAudience,
  mappingGaps,
  rejectSentence,
  safeCsvFilename,
  toCsv,
  type ColumnMapping,
} from "../src/bulk/index.ts";

/**
 * The cleaning pipeline, which is the only thing standing between a
 * spreadsheet and a message to a stranger.
 *
 * Every assertion here is about a count somebody reads on the confirm screen
 * before pressing send. A pipeline that silently dropped rows would look like
 * a smaller list rather than like a bug, and one that silently KEPT a bad row
 * is a message to a wrong number that cannot be un-sent.
 */

const MAPPING: ColumnMapping = {
  phone: "Mobile",
  variables: { "1": "Name", "2": "Order" },
};

function row(mobile: string, name = "Anita", order = "1204") {
  return { Mobile: mobile, Name: name, Order: order };
}

describe("normalising", () => {
  it("accepts a local Indian number and stores it as E.164", () => {
    /* The default region is IN, so a number typed the way an Indian customer
       list holds it has to survive without a country code. */
    const result = buildAudience([row("98765 43210")], MAPPING);

    expect(result.recipients).toEqual([
      { phoneE164: "+919876543210", variables: ["Anita", "1204"] },
    ]);
  });

  it("lets an explicit country code win over the default region", () => {
    /*
     * A real UK mobile range, not 07700 900xxx. That one is Ofcom's reserved
     * drama block and libphonenumber refuses it as invalid - correctly, and it
     * failed this test on the first run. Worth the note: the obvious "example"
     * numbers for several countries are reserved precisely so they route
     * nowhere, which makes them the wrong fixtures for a validity check.
     */
    const result = buildAudience([row("+44 7911 123456")], MAPPING);

    expect(result.recipients[0]?.phoneE164).toBe("+447911123456");
  });

  it("treats the same person written three ways as one recipient", () => {
    /*
     * The reason normalisation happens BEFORE deduping. Three spellings of one
     * number are one person, and a dedupe on the raw string would send them
     * three messages.
     */
    const result = buildAudience(
      [row("+91 98765 43210"), row("098765 43210"), row("9876543210")],
      MAPPING,
    );

    expect(result.recipients).toHaveLength(1);
    expect(result.counts.duplicate).toBe(2);
  });
});

describe("rejecting", () => {
  it("rejects an empty cell as missing, not as unparseable", () => {
    /* Different advice: one means the row has no number, the other means it
       has one nobody can be reached on. */
    const result = buildAudience([row("")], MAPPING);

    expect(result.rejects).toEqual([
      { row: 2, value: "", reason: "missing_phone" },
    ]);
    expect(result.recipients).toHaveLength(0);
  });

  it("rejects a number no carrier could route", () => {
    const result = buildAudience([row("12345")], MAPPING);

    expect(result.rejects[0]?.reason).toBe("unparseable_phone");
  });

  it("numbers rows the way a spreadsheet does", () => {
    /*
     * The header is row 1, so the first data row is row 2. Off by one here and
     * every line of the rejects file points at the wrong customer - worse than
     * useless, because somebody will fix the row it names.
     */
    const result = buildAudience([row("98765 43210"), row("nonsense")], MAPPING);

    expect(result.rejects[0]?.row).toBe(3);
  });

  it("keeps the original value, so the file can be corrected", () => {
    const result = buildAudience([row("  not-a-number  ")], MAPPING);

    expect(result.rejects[0]?.value).toBe("not-a-number");
  });

  it("gives a reason for every rejection it can produce", () => {
    for (const reason of [
      "missing_phone",
      "unparseable_phone",
      "duplicate_in_file",
    ] as const) {
      expect(rejectSentence(reason), `no sentence for ${reason}`).toBeTruthy();
    }
  });

  it("keeps the first occurrence and rejects the later one", () => {
    /*
     * Deliberate, and visible on the rejects file: a list is usually ordered
     * with the best data first, so reporting the later row as the duplicate is
     * the more useful direction.
     */
    const result = buildAudience(
      [row("98765 43210", "Anita"), row("98765 43210", "A. Desai")],
      MAPPING,
    );

    expect(result.recipients[0]?.variables[0]).toBe("Anita");
    expect(result.rejects[0]?.row).toBe(3);
  });

  it("does not complain twice about one bad row", () => {
    /* A row with no phone has no message to send, so a second complaint about
       its missing name is noise on a line that is going to be deleted. */
    const result = buildAudience([{ Mobile: "", Name: "", Order: "" }], MAPPING);

    expect(result.rejects).toHaveLength(1);
  });
});

describe("the variables", () => {
  it("puts them in Meta's positional order", () => {
    const result = buildAudience([row("98765 43210", "Anita", "1204")], MAPPING);

    expect(result.recipients[0]?.variables).toEqual(["Anita", "1204"]);
  });

  it("sorts positions numerically, not lexically", () => {
    /*
     * The bug this exists to prevent: as a string, "10" sorts between "1" and
     * "2", so a ten-variable template silently sends every parameter in the
     * wrong slot - names where prices go, on every message in the run.
     */
    const mapping: ColumnMapping = {
      phone: "Mobile",
      variables: { "1": "A", "2": "B", "10": "J" },
    };

    const result = buildAudience(
      [{ Mobile: "9876543210", A: "one", B: "two", J: "ten" }],
      mapping,
    );

    expect(result.recipients[0]?.variables).toEqual(["one", "two", "ten"]);
  });

  it("renders an unmapped or absent cell as a blank, never undefined", () => {
    /* Meta requires a parameter for every position. A hole would be a refused
       send at the far end of a queue; a blank is the honest rendering of an
       empty cell. */
    const result = buildAudience([{ Mobile: "9876543210" }], MAPPING);

    expect(result.recipients[0]?.variables).toEqual(["", ""]);
  });
});

describe("the counts", () => {
  it("adds up to the file", () => {
    /*
     * parsed = kept + invalid + duplicate. If that stops holding, the confirm
     * screen shows numbers that do not reconcile and the tenant is right not
     * to trust any of them.
     */
    const result = buildAudience(
      [
        row("98765 43210"),
        row("98765 43211"),
        row("98765 43210"),
        row(""),
        row("junk"),
      ],
      MAPPING,
    );

    const { parsed, invalid, duplicate } = result.counts;

    expect(parsed).toBe(5);
    expect(invalid).toBe(2);
    expect(duplicate).toBe(1);
    expect(result.recipients.length + invalid + duplicate).toBe(parsed);
  });

  it("produces one reject line per dropped row", () => {
    const result = buildAudience(
      [row(""), row("junk"), row("98765 43210")],
      MAPPING,
    );

    expect(result.rejects).toHaveLength(
      result.counts.invalid + result.counts.duplicate,
    );
  });
});

describe("the mapping", () => {
  it("names every gap, so the screen can point at the field", () => {
    const gaps = mappingGaps({ phone: "", variables: { "1": "Name" } }, 2);

    expect(gaps).toEqual(["phone", "{{2}}"]);
  });

  it("is complete when every variable has a column", () => {
    expect(mappingGaps(MAPPING, 2)).toEqual([]);
  });
});

describe("writing a CSV", () => {
  it("quotes every field and doubles an embedded quote", () => {
    const csv = toCsv(["a", "b"], [['say "hi"', "x,y"]]);

    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"x,y"');
  });

  it("starts with a BOM so Excel reads it as UTF-8", () => {
    /* Without it, Excel on Windows reads the file as the system codepage and
       the tenant's first experience of the export is that it mangled their
       customers' names. */
    expect(toCsv(["a"], [["Ravi Ramanathan"]]).startsWith("﻿")).toBe(true);
  });

  it("keeps a leading plus rather than letting a spreadsheet read a formula", () => {
    expect(toCsv(["phone"], [["+919876543210"]])).toContain('"+919876543210"');
  });

  it("strips a filename that would split a header", () => {
    const name = safeCsvFilename('list".csv\r\nSet-Cookie: a=b', "rejects");

    expect(name).not.toContain("\r");
    expect(name).not.toContain('"');
    expect(name.endsWith(".csv")).toBe(true);
  });

  it("falls back when nothing survives the strip", () => {
    expect(safeCsvFilename("///", "rejects")).toBe("rejects.csv");
  });
});
