import { graphGetJson } from "../providers/meta.ts";
import type { FailureKind, FetchImpl } from "../providers/types.ts";

/**
 * The numbers on a WhatsApp Business Account, as Meta currently describes them.
 *
 * Everything here is a cache of somebody else's state: the display number, the
 * name they approved, the quality rating and the messaging tier all live at
 * Meta and change without telling us. Storing them is what keeps a dashboard
 * from calling the Graph API every time it renders - see metadataRefreshedAt,
 * which exists so the page can say how old the answer is instead of hiding it.
 */

export interface WhatsAppNumberFacts {
  /** Meta's id. The only stable key; the display number is not one. */
  phoneNumberId: string;
  displayNumber: string;
  verifiedName: string | null;
  /** GREEN | YELLOW | RED | UNKNOWN. A closed set, so an enum in the schema. */
  qualityRating: string;
  /**
   * Meta's own strings - TIER_1K and friends. Text everywhere, because the set
   * has changed twice and an unrecognised tier must render as itself at 3am
   * rather than reject the refresh that carried it.
   */
  messagingTier: string | null;
  throughputLevel: string | null;
  /** Meta's status vocabulary, stored verbatim. See 20260816100000. */
  status: string;
}

export type NumbersFetchOutcome =
  | { ok: true; numbers: WhatsAppNumberFacts[] }
  | { ok: false; kind: FailureKind; error: string };

interface NumbersResponse {
  data?: Array<{
    id?: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    messaging_limit_tier?: string;
    throughput?: { level?: string };
    status?: string;
  }>;
}

/** The fields worth asking for. Named explicitly so the answer is predictable. */
const FIELDS = [
  "id",
  "display_phone_number",
  "verified_name",
  "quality_rating",
  "messaging_limit_tier",
  "throughput",
  "status",
].join(",");

/**
 * Ask Meta for every number on the account.
 *
 * The whole list rather than one number at a time, because the caller needs to
 * know what is NOT there: a number we hold that Meta does not return is the
 * case the missing_since column exists for, and it is only visible from a
 * complete answer.
 *
 * Which is also why a partial answer must not look like a complete one. There
 * is no paging here and that is a real limit, stated rather than hidden: an
 * account with more numbers than one page returns would appear to have lost
 * the rest. Meta's default page is large and a tenant has a handful of numbers,
 * so this is a correctness note for whoever adds the fiftieth, not a bug today.
 */
export async function fetchWhatsAppNumbers(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<NumbersFetchOutcome> {
  const accountId = secrets["WHATSAPP_BUSINESS_ACCOUNT_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!accountId || !accessToken) {
    return {
      ok: false,
      kind: "config",
      error: "Business account ID and access token are both required.",
    };
  }

  const result = await graphGetJson<NumbersResponse>(
    `${accountId}/phone_numbers`,
    FIELDS,
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  if (!result.ok) {
    return { ok: false, kind: result.kind, error: result.error };
  }

  const rows = result.data.data ?? [];

  /*
   * A row with no id cannot be matched to anything we hold and cannot be
   * inserted - phone_number_id is the natural key. Dropped rather than
   * defaulted, because a number keyed on an empty string would collide with
   * the next one.
   */
  const numbers = rows
    .filter((row): row is { id: string } & typeof row => Boolean(row.id))
    .map((row) => ({
      phoneNumberId: row.id,
      displayNumber: row.display_phone_number ?? "",
      verifiedName: row.verified_name ?? null,
      /* UNKNOWN rather than null: the column is an enum with that member, and
         "Meta did not say" is exactly what it means. */
      qualityRating: normaliseQuality(row.quality_rating),
      messagingTier: row.messaging_limit_tier ?? null,
      throughputLevel: row.throughput?.level ?? null,
      status: row.status ?? "UNKNOWN",
    }));

  return { ok: true, numbers };
}

/**
 * Quality is a closed traffic light, so an unrecognised value becomes UNKNOWN.
 *
 * The opposite treatment to status, and deliberately: GREEN/YELLOW/RED is a
 * rating scale Meta is not extending, and it is stored as an enum. A value
 * outside it is far more likely to be a typo or a shape change than a fifth
 * colour, and the column cannot hold it either way.
 */
const QUALITY_RATINGS = new Set(["GREEN", "YELLOW", "RED", "UNKNOWN"]);

function normaliseQuality(raw: string | undefined): string {
  const value = (raw ?? "").toUpperCase();
  return QUALITY_RATINGS.has(value) ? value : "UNKNOWN";
}
