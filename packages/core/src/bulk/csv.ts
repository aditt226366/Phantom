/**
 * Writing a CSV, for the two files this phase hands back.
 *
 * Writing only. Reading is papaparse's job in apps/web, and the asymmetry is
 * deliberate: parsing somebody else's CSV is a genuinely hard problem full of
 * quoting dialects and BOMs, and writing one we control is twenty lines. A
 * dependency for the second half would be carried into the worker and into
 * core for no benefit.
 *
 * RFC 4180 quoting: every field is quoted, and a quote inside a field is
 * doubled. Quoting unconditionally rather than only when needed - it is always
 * valid, it removes the decision, and it means a phone number keeps its
 * leading + instead of being read as a formula by a spreadsheet.
 */

/** CRLF, which is what RFC 4180 says and what Excel expects. */
const ROW_SEPARATOR = "\r\n";

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Rows to a CSV body, with the header first.
 *
 * A leading BOM, because Excel on Windows reads a BOM-less UTF-8 file as the
 * system codepage - so a customer called Ravi Ramanathan opens as Ravi
 * RamanÄthan, and the tenant's first experience of the export is that it
 * mangled their contacts. It costs three bytes.
 */
export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const lines = [header, ...rows].map((row) => row.map(quote).join(","));
  return `\uFEFF${lines.join(ROW_SEPARATOR)}${ROW_SEPARATOR}`;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * The same treatment the media and KYC routes give an uploaded name, and for
 * the same reason: part of this one comes from a file the tenant chose, so a
 * newline in it splits the response and a quote closes the parameter early.
 */
export function safeCsvFilename(stem: string, fallback: string): string {
  const cleaned = stem
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 80);

  return `${cleaned.length > 0 ? cleaned : fallback}.csv`;
}
