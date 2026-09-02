import { z } from "zod";

/**
 * What a lead source binds, and what it does when a row appears.
 *
 * ---------------------------------------------------------------------------
 * The action is a discriminated field on day one, with one member
 * ---------------------------------------------------------------------------
 *
 * Today a binding can do exactly one thing: send an approved template to every
 * new row. The flow builder (A1) and the AI layer (A2) are both meant to become
 * alternative actions on the same binding - the same sheet, the same mapping,
 * the same cleaning, a different thing at the end.
 *
 * So the shape is a discriminated union from the start, even though the union
 * has one member and a linter would be entitled to call that pointless. The
 * alternative is a binding with a `templateId` column and a set of assumptions
 * spread across a poll job, a form and a report - and turning that into two
 * kinds later means finding all of them. A second member here is a case in a
 * switch that fails to compile until it is handled.
 *
 * The kind lives in its own column rather than only inside the jsonb, so a
 * query can ask which bindings send templates without opening every config, and
 * so an action nobody declared is unrepresentable rather than merely unread.
 */

/** The mapping shape, mirroring bulk's ColumnMapping. */
const columnMappingSchema = z.object({
  /** The sheet header whose cell is the recipient's number. */
  phone: z.string().min(1),
  /** Header per template variable, keyed by Meta's 1-based position. */
  variables: z.record(z.string(), z.string()),
});

/**
 * Send this approved template.
 *
 * Cold recipients, so template-only. That is Meta's rule rather than ours and
 * sendPolicy already enforces it; declaring it here means a free-form lead
 * source is not merely refused but unrepresentable, exactly as
 * broadcasts.template_id being NOT NULL does for bulk.
 */
export const templateActionSchema = z.object({
  kind: z.literal("TEMPLATE"),
  templateId: z.string().min(1),
  mapping: columnMappingSchema,
});

/**
 * Start a flow instead of sending one template and stopping.
 *
 * ---------------------------------------------------------------------------
 * A flow binding still sends a template, and that is the point
 * ---------------------------------------------------------------------------
 *
 * A cold lead has never written to us, so the 24-hour window is not open and
 * an interactive message cannot be sent - which means a FLOW binding contacts
 * a row in exactly the way a TEMPLATE binding does: one approved template.
 * What differs is the payloads on its quick-reply buttons, which encode the
 * flow version and its entry node, so that a tap starts a run.
 *
 * So nothing above the action switch in the poll handler changes. The sheet,
 * the tab, the mapping, the cleaning, the cursor and the idempotency index are
 * all untouched - which is what the discriminated column was built for, and
 * wiring the second member is what proves the shape was right.
 *
 * Names a VERSION rather than a flow, for the reason the column does: a run
 * pins its version, and a binding naming the flow would put every row it read
 * into whatever happened to be published that minute - so republishing
 * mid-import would split one afternoon's leads across two different trees with
 * nothing to say so.
 */
export const flowActionSchema = z.object({
  kind: z.literal("FLOW"),
  flowVersionId: z.string().min(1),
  mapping: columnMappingSchema,
});

/**
 * Enrol the row in a Verse campaign.
 *
 * The third member, and structurally the simplest. A cold lead has never
 * written to us, so the 24-hour window is shut and the only thing that may go
 * out is an approved template - which is what a TEMPLATE binding already
 * sends. What differs is afterwards: the conversation is claimed for Verse, so
 * the reply is answered from the campaign's knowledge base rather than landing
 * in the inbox unattended.
 *
 * It names a CAMPAIGN rather than a knowledge base and a model separately,
 * because a campaign is already the thing that bundles those with a template,
 * a schedule and a cap - and a binding that could set them independently would
 * be a second place for a campaign's configuration to live.
 */
export const verseActionSchema = z.object({
  kind: z.literal("VERSE"),
  verseCampaignId: z.string().min(1),
  mapping: columnMappingSchema,
});

/**
 * Every action a binding can carry.
 *
 * A discriminatedUnion rather than a plain union: with one member the two are
 * identical, and with two the discriminated form reports "unknown kind"
 * instead of listing every field of every member as a possible error. With
 * three that property is doing real work.
 */
export const leadSourceActionSchema = z.discriminatedUnion("kind", [
  templateActionSchema,
  flowActionSchema,
  verseActionSchema,
]);

export type TemplateAction = z.infer<typeof templateActionSchema>;
export type FlowAction = z.infer<typeof flowActionSchema>;
export type VerseAction = z.infer<typeof verseActionSchema>;
export type LeadSourceAction = z.infer<typeof leadSourceActionSchema>;

/** The kinds, for the enum column and for exhaustiveness. */
export const LEAD_SOURCE_ACTIONS = ["TEMPLATE", "FLOW", "VERSE"] as const;
export type LeadSourceActionKind = (typeof LEAD_SOURCE_ACTIONS)[number];

/**
 * Read a stored action config, or nothing.
 *
 * jsonb holds whatever was written, including something written by a build
 * that predates a field. A config this cannot read is null rather than a
 * throw: a poll job that crashes on every attempt is a binding nobody can even
 * disable, and null is a state the report has a sentence for.
 */
export function parseLeadSourceAction(raw: unknown): LeadSourceAction | null {
  const result = leadSourceActionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------------- *
 * The sheet
 * ------------------------------------------------------------------------- */

export type SheetRefResult =
  | { ok: true; spreadsheetId: string; gid: number | null }
  | { ok: false; reason: string };

/**
 * Google's own id, out of whatever the tenant pasted.
 *
 * They paste the URL from the address bar, because that is what "share this
 * sheet" produces and nobody has ever gone looking for the id on its own. The
 * shapes that actually arrive:
 *
 *   https://docs.google.com/spreadsheets/d/<id>/edit#gid=0
 *   https://docs.google.com/spreadsheets/d/<id>/edit?gid=884#gid=884
 *   https://docs.google.com/spreadsheets/d/<id>
 *   <id>
 *
 * The gid is kept when it is there. It identifies the tab they were looking at
 * when they copied the URL, which is very often the tab they mean, and offering
 * it pre-selected removes the one step of this form most likely to be got
 * wrong silently - picking the wrong tab imports a different list and reports
 * no error at all.
 *
 * A URL for something that is not a spreadsheet is refused by name rather than
 * left to fail later as a 404 from Google. "That is a Google Doc, not a Sheet"
 * is a sentence somebody can act on; "Requested entity was not found" is not.
 */
export function parseSheetRef(input: string): SheetRefResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, reason: "Paste the link to your Google Sheet." };
  }

  if (!trimmed.includes("/") && !trimmed.includes(" ")) {
    /* A bare id. Google's are 40-odd characters of base64url; the bound is
       loose because the length is theirs to change and refusing a real id is
       worse than accepting a wrong one that then 404s honestly. */
    return ID_PATTERN.test(trimmed)
      ? { ok: true, spreadsheetId: trimmed, gid: null }
      : {
          ok: false,
          reason: "That does not look like a Google Sheet link or ID.",
        };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a link we can read." };
  }

  if (!/(^|\.)google\.com$/.test(url.hostname)) {
    return {
      ok: false,
      reason: "That link is not on google.com. Paste the sheet's own URL.",
    };
  }

  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname);

  if (!match?.[1]) {
    if (url.pathname.startsWith("/document/")) {
      return { ok: false, reason: "That is a Google Doc, not a Google Sheet." };
    }
    if (url.pathname.startsWith("/forms/")) {
      return {
        ok: false,
        reason:
          "That is a Google Form. Bind the sheet the form writes its responses to.",
      };
    }
    return { ok: false, reason: "That link does not name a spreadsheet." };
  }

  return { ok: true, spreadsheetId: match[1], gid: readGid(url) };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{20,120}$/;

/**
 * The tab id, from the fragment or the query.
 *
 * Google puts it in the fragment (`#gid=884`) and, on newer links, the query
 * as well. Both are read because which one is present depends on how the link
 * was copied, and a tenant does not know there is a difference.
 */
function readGid(url: URL): number | null {
  const fromQuery = url.searchParams.get("gid");
  const fromHash = /(?:^|[#&])gid=(\d+)/.exec(url.hash)?.[1];
  const raw = fromHash ?? fromQuery;

  if (raw === null || raw === undefined) return null;

  const gid = Number(raw);
  return Number.isInteger(gid) && gid >= 0 ? gid : null;
}

/* ------------------------------------------------------------------------- *
 * The poll interval
 * ------------------------------------------------------------------------- */

/**
 * How often a binding is read, and what the bounds cost.
 *
 * Sheets allows a limited number of reads per minute per project - not per
 * tenant, per PROJECT, so every binding in the system shares one allowance.
 * The arithmetic is the reason the floor is where it is, and it is worth
 * having in front of whoever next wants to make it faster:
 *
 *   interval   reads/min per binding   bindings before 300/min
 *   10s        6                       50
 *   30s        2                       150
 *   60s        1                       300
 *   300s       0.2                     1500
 *
 * Thirty seconds is the default because it is fast enough that a lead
 * submitted from a form is contacted while they still remember filling it in,
 * and slow enough to carry a few hundred tenants. Ten is the floor rather than
 * one: a binding polling every second would consume the whole project's quota
 * by itself and take every other tenant's bindings down with it.
 *
 * The Apps Script path is the answer for anybody who genuinely needs it
 * instant. It costs no quota at all, because the sheet tells us.
 */
export const POLL_INTERVAL_DEFAULT_SECONDS = 30;
export const POLL_INTERVAL_MIN_SECONDS = 10;
/** A day. Past this a lead source is a monthly report, not a lead source. */
export const POLL_INTERVAL_MAX_SECONDS = 86_400;

export const pollIntervalSchema = z
  .number()
  .int()
  .min(POLL_INTERVAL_MIN_SECONDS)
  .max(POLL_INTERVAL_MAX_SECONDS);

/** Clamp rather than refuse, for a value arriving from an older row. */
export function clampPollInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return POLL_INTERVAL_DEFAULT_SECONDS;
  return Math.min(
    POLL_INTERVAL_MAX_SECONDS,
    Math.max(POLL_INTERVAL_MIN_SECONDS, Math.round(seconds)),
  );
}
