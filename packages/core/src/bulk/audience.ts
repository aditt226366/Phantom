import { parsePhone } from "../phone.ts";

/**
 * Turning an uploaded spreadsheet into an audience, one step at a time.
 *
 * Pure, and it takes already-parsed rows rather than a file, for the reason
 * sendPolicy and canUseFeatures are pure: the decisions here are the ones a
 * tenant sees a count for on the confirm screen, and they have to be testable
 * without a CSV parser, a database or a request. Reading the file is the
 * caller's job.
 *
 * ---------------------------------------------------------------------------
 * The order is the product, not an implementation detail
 * ---------------------------------------------------------------------------
 *
 *   parse           the caller's, before this runs
 *   normalise       to E.164, India assumed - the existing parsePhone
 *   reject          anything that will not parse, with the row number
 *   dedupe in file  the same person listed twice gets one message
 *   dedupe vs book  against existing contacts        (needs the database)
 *   drop opted out  and the undeliverable            (needs the database)
 *
 * The last two need a company scope, so they live in packages/db. This module
 * does the first four and hands over a list the database half can finish.
 *
 * Every step reports a count, because the confirm screen shows all of them.
 * "1,204 parsed, 11 unparseable, 38 duplicates" is what tells somebody their
 * mapping is wrong BEFORE the messages go out - a phone column mapped to the
 * name column rejects every row, and the only symptom is a number.
 */

/** Which column feeds the phone, and which feeds each template variable. */
export interface ColumnMapping {
  /** The CSV header whose cell is the recipient's number. */
  phone: string;
  /**
   * Header per template variable, keyed by Meta's 1-based position.
   *
   * Keyed rather than an array because it is edited a field at a time in the
   * UI and a sparse array is a worse thing to hold half-filled.
   */
  variables: Record<string, string>;
}

/** One row that survived. */
export interface AudienceRow {
  /** E.164. The only form anything downstream sees. */
  phoneE164: string;
  /**
   * The template's parameters, in Meta's positional order.
   *
   * An array, because Meta matches {{1}} and {{2}} by position. Built here so
   * that no later step has to re-read the mapping to put them back in order -
   * getting that wrong puts the order number where the customer's name goes.
   */
  variables: string[];
}

export type RejectReason =
  /** The mapped cell was empty. */
  | "missing_phone"
  /** parsePhone refused it: not a number anybody can be reached on. */
  | "unparseable_phone"
  /** An earlier row in the same file already had this number. */
  | "duplicate_in_file";

/** A row that did not survive, and enough to find it in the original file. */
export interface AudienceReject {
  /** 1-based, counting the header as row 1, so it matches a spreadsheet. */
  row: number;
  /** Whatever was in the phone cell, verbatim. */
  value: string;
  reason: RejectReason;
}

export interface AudienceResult {
  recipients: AudienceRow[];
  rejects: AudienceReject[];
  counts: {
    /** Rows in the file, excluding the header. */
    parsed: number;
    /** Rejected as missing or unparseable. */
    invalid: number;
    /** Dropped because an earlier row held the same number. */
    duplicate: number;
  };
}

/**
 * Normalise, reject and dedupe.
 *
 * The first occurrence of a number wins and later ones are rejected, rather
 * than the last winning. That is deliberate and visible on the rejects file: a
 * list is usually ordered with the best data first, and reporting row 900 as
 * the duplicate of row 12 is more useful than the reverse.
 *
 * A row rejected for its phone is not examined for its variables. There is no
 * message to send it, so a second complaint about a missing name would be
 * noise on a line the tenant is going to delete.
 */
export function buildAudience(
  rows: ReadonlyArray<Record<string, string>>,
  mapping: ColumnMapping,
): AudienceResult {
  /* Meta's positional order, resolved once. Sorting numerically rather than
     lexically, or {{10}} would land between {{1}} and {{2}}. */
  const positions = Object.keys(mapping.variables)
    .map((key) => Number(key))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  const recipients: AudienceRow[] = [];
  const rejects: AudienceReject[] = [];
  const seen = new Set<string>();

  let invalid = 0;
  let duplicate = 0;

  rows.forEach((row, index) => {
    /* +2: the header is row 1 and the array is 0-based, so the first data row
       is row 2 - which is what a spreadsheet shows and what somebody opening
       the rejects file will look for. */
    const lineNumber = index + 2;
    const raw = (row[mapping.phone] ?? "").trim();

    if (raw.length === 0) {
      invalid += 1;
      rejects.push({ row: lineNumber, value: "", reason: "missing_phone" });
      return;
    }

    const parsed = parsePhone(raw);

    if (!parsed.ok) {
      invalid += 1;
      rejects.push({ row: lineNumber, value: raw, reason: "unparseable_phone" });
      return;
    }

    if (seen.has(parsed.e164)) {
      duplicate += 1;
      rejects.push({ row: lineNumber, value: raw, reason: "duplicate_in_file" });
      return;
    }

    seen.add(parsed.e164);

    recipients.push({
      phoneE164: parsed.e164,
      /*
       * Empty string for an unmapped or absent cell, never undefined. Meta
       * requires a parameter for every {{n}} in the template, so a hole here
       * is a refused send at the far end of a queue rather than a blank in a
       * message - and a blank is the honest rendering of a missing cell.
       */
      variables: positions.map((n) =>
        (row[mapping.variables[String(n)] ?? ""] ?? "").trim(),
      ),
    });
  });

  return {
    recipients,
    rejects,
    counts: { parsed: rows.length, invalid, duplicate },
  };
}

/** The sentence the rejects file puts beside each dropped row. */
export function rejectSentence(reason: RejectReason): string {
  switch (reason) {
    case "missing_phone":
      return "No number in the mapped column";
    case "unparseable_phone":
      return "Not a number anyone can be reached on";
    case "duplicate_in_file":
      return "The same number appears earlier in this file";
  }
}

/**
 * Is this mapping complete for a template with this many variables?
 *
 * Checked before the audience is built rather than after, because a mapping
 * missing {{2}} produces an audience whose every message has a blank in it -
 * technically sendable, and wrong for everybody on the list.
 */
export function mappingGaps(
  mapping: ColumnMapping,
  variableCount: number,
): string[] {
  const gaps: string[] = [];

  if (!mapping.phone) gaps.push("phone");

  for (let n = 1; n <= variableCount; n++) {
    if (!mapping.variables[String(n)]) gaps.push(`{{${n}}}`);
  }

  return gaps;
}
