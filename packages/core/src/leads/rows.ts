/**
 * Turning a sheet into rows, and deciding which of them are new.
 *
 * Pure, and it takes cells rather than a spreadsheet id, for the reason
 * buildAudience takes parsed rows: what counts as a new lead is the decision
 * this whole feature turns on, and it has to be testable without a network, a
 * database or a Google credential. Client-safe too, because the mapping
 * screen's preview runs the same functions the poll does - see the note on the
 * hash, which is the one piece that could not stay here.
 */

/**
 * A sheet's header row and its data rows, as the mapping screen sees them.
 *
 * Google returns a ragged array - trailing blanks are trimmed per row, so a row
 * whose last cell is empty comes back shorter than the header. Every consumer
 * here would otherwise need its own bounds check, and the one that forgets
 * reads `undefined` into a template variable.
 */
export interface SheetContent {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Header row plus data rows, as records keyed by column name.
 *
 * The shape buildAudience already takes, so the cleaning pipeline is reused
 * rather than reimplemented - E.164 via parsePhone with the India default,
 * rejects with reasons, dedupe within the batch.
 *
 * A blank header is dropped: Google returns cells for columns somebody once
 * typed in and cleared, and an unnamed column cannot be mapped to anything.
 * A DUPLICATE header keeps the first, because that is the one the mapping
 * screen offered - the alternative silently maps to a column the tenant did
 * not choose, which is the failure mode with no symptom.
 */
export function toRecords(values: ReadonlyArray<readonly string[]>): SheetContent {
  const rawHeaders = values[0] ?? [];
  const headers: string[] = [];
  /** Header name to its column index, first occurrence winning. */
  const columns = new Map<string, number>();

  rawHeaders.forEach((header, index) => {
    const name = String(header ?? "").trim();
    if (!name || columns.has(name)) return;
    columns.set(name, index);
    headers.push(name);
  });

  const rows = values.slice(1).map((row) => {
    const record: Record<string, string> = {};
    for (const [name, index] of columns) {
      record[name] = String(row[index] ?? "").trim();
    }
    return record;
  });

  return { headers, rows };
}

/**
 * The first few rows, for the form's live preview.
 *
 * Three, because that is enough to show a mapping working and few enough that
 * a tenant reads all of them. One preview hides a mapping that happens to be
 * right for row two and wrong for row three, which is what an off-by-one in a
 * header does.
 */
export const PREVIEW_ROWS = 3;
