import "server-only";
import { readSheetValues, type ValuesOutcome } from "@whatsapp-os/core";

/**
 * Reading a bound sheet for a page to render.
 *
 * ---------------------------------------------------------------------------
 * Why this wrapper exists, and exactly how far it goes
 * ---------------------------------------------------------------------------
 *
 * The mapping screen is the one place in this feature where a PAGE, not a
 * worker, has to call Google before it can render anything. That makes it the
 * one screen the screenshot suite cannot photograph: there is no network in
 * the gate, so every capture would spend the full ten-second provider timeout
 * and then photograph an error state - twice, at two viewports, on every run.
 *
 * And it is the screen most worth photographing. A mapping is easy to get
 * wrong in a way that is invisible as a set of dropdowns and obvious as a
 * sentence, and this one runs unattended for months rather than going out once
 * under somebody's eye.
 *
 * So the read goes through here, and when LEAD_SHEET_FIXTURE is set it answers
 * from a literal instead. The variable is set by playwright.config.ts and by
 * nothing else - not .env, not the Dockerfile, not any deployment.
 *
 * ---------------------------------------------------------------------------
 * What this can and cannot do, because a test hook in production code earns
 * that question
 * ---------------------------------------------------------------------------
 *
 * It changes which CELLS a form renders in a preview. That is the whole of it.
 * It cannot send a message, cannot claim a lead, cannot reach the poll job -
 * the worker has its own call to readSheetValues and does not import this - and
 * cannot alter what any row hashes to, because hashing happens in the worker
 * from what the worker read.
 *
 * The bound it does not have is worth stating too: an operator who set this in
 * production would see a fictional preview on a mapping screen and map their
 * columns against it. That is a real way to configure a binding wrongly, which
 * is why the value is a fixed sentinel rather than a path or a JSON blob - it
 * can only ever produce this one obviously-fake sheet, whose columns are named
 * after the fixture and whose numbers are the reserved 98765 range.
 */

/** The one value that switches this. Anything else reads Google. */
const FIXTURE_SENTINEL = "northwind-visual-fixture";

/**
 * The literal sheet the screenshot suite maps against.
 *
 * Deliberately imperfect: row three has no number, so the preview photographs
 * the "no number in this row" branch rather than three tidy sentences that say
 * nothing about what the screen does when a spreadsheet is messy. The columns
 * match the mapping the seed stores, so the page opens already mapped.
 */
const FIXTURE_ROWS: string[][] = [
  ["Name", "Mobile", "Order"],
  ["Anita Desai", "98765 43210", "NW-2291"],
  ["Vikram Shah", "+91 98765 43211", "NW-2288"],
  ["Rahul Nair", "", "NW-2284"],
  ["Fatima Sheikh", "98765 43213", "NW-2280"],
];

/** True when this process is rendering for the screenshot suite. */
export function usingSheetFixture(): boolean {
  return process.env["LEAD_SHEET_FIXTURE"] === FIXTURE_SENTINEL;
}

/**
 * One tab's cells, for a page.
 *
 * The same signature as the adapter's, so a caller that stops going through
 * here is a diff rather than a silent divergence.
 */
export async function readBindingSheet(
  secrets: Readonly<Record<string, string>>,
  spreadsheetId: string,
  tab: string,
): Promise<ValuesOutcome> {
  if (usingSheetFixture()) return { ok: true, rows: FIXTURE_ROWS };

  return readSheetValues(secrets, spreadsheetId, tab);
}

/** The tabs a page offers. Fixture-aware for the same reason. */
export async function listBindingTabs(
  secrets: Readonly<Record<string, string>>,
  spreadsheetId: string,
): Promise<{ ok: true; titles: string[] } | { ok: false }> {
  if (usingSheetFixture()) return { ok: true, titles: ["Leads", "Archive"] };

  const { listSheetTabs } = await import("@whatsapp-os/core");
  const listed = await listSheetTabs(secrets, spreadsheetId);

  return listed.ok
    ? { ok: true, titles: listed.tabs.map((tab) => tab.title) }
    : { ok: false };
}
