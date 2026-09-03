import { FLOOR, VERSE_MODELS, formatMinutes } from "@whatsapp-os/core/verse";
import type { VerseTier } from "@whatsapp-os/core/verse";

/**
 * What the Verse screens say, extracted so it can be asserted.
 *
 * The repository's rule about source-level checks applies to copy as well: a
 * test that a page CONTAINS a word stayed green when the control was deleted,
 * because the word survived in a neighbouring heading. Extracting the decision
 * into a function and asserting both branches is two lines more and actually
 * fails.
 */

export type DocumentStatus =
  | "PENDING"
  | "EXTRACTING"
  | "EMBEDDING"
  | "INDEXED"
  | "FAILED";

export function documentStatusLabel(status: DocumentStatus): string {
  switch (status) {
    case "PENDING":
      return "Queued";
    case "EXTRACTING":
      return "Reading";
    case "EMBEDDING":
      return "Indexing";
    case "INDEXED":
      return "Ready";
    case "FAILED":
      return "Failed";
  }
}

/**
 * Badge carries its colour on the TEXT rather than a fill, and has five
 * variants. Mapping to them here rather than inventing names keeps the badges
 * on this screen looking like every other badge in the product.
 */
export function documentStatusVariant(
  status: DocumentStatus,
): "default" | "outline" | "success" | "error" {
  switch (status) {
    case "INDEXED":
      return "success";
    case "FAILED":
      return "error";
    case "PENDING":
      return "outline";
    default:
      /* Reading and Indexing are in-flight: neither good news nor bad. */
      return "default";
  }
}

/**
 * What a document contributes to retrieval, in one sentence.
 *
 * A chunk count is meaningless to a tenant - "47 chunks" is our vocabulary,
 * not theirs - so the count is phrased as what it does. A FAILED document says
 * nothing here because its failure reason is shown in full instead, and
 * repeating "0 passages" beside it would read as a second problem.
 */
export function documentContribution(
  status: DocumentStatus,
  chunkCount: number,
): string | null {
  if (status !== "INDEXED") return null;
  if (chunkCount === 0) {
    /*
     * Indexed with nothing in it. Reachable when a document extracts to text
     * that chunks to nothing, and it must not render as "Ready" with no
     * qualification - a knowledge base that looks indexed and answers nothing
     * is the failure the ingestion path works hardest to prevent.
     */
    return "Nothing was found to index in this document.";
  }
  return chunkCount === 1
    ? "1 passage Verse can answer from"
    : `${chunkCount} passages Verse can answer from`;
}

/* ------------------------------------------------------------------------- *
 * The floor's provenance, rendered where somebody is looking
 * ------------------------------------------------------------------------- */

export interface FloorNotice {
  /** Null when the floor has been measured. Nothing to say. */
  headline: string | null;
  detail: string;
}

/**
 * What to tell a tenant about the retrieval threshold.
 *
 * ---------------------------------------------------------------------------
 * Why a tenant is told at all
 * ---------------------------------------------------------------------------
 *
 * The floor decides whether Verse answers or says it does not know, and it has
 * never been measured. That is a fact about how their assistant behaves, and it
 * has two failure directions that look completely different from the outside:
 * set too high it refuses questions the knowledge base answers, set too low it
 * answers from passages that do not support the answer.
 *
 * A tenant seeing either would reasonably conclude something else was wrong -
 * their documents, their wording, the model - so the honest thing is to say
 * where the number came from, on the page where they are looking at retrieval.
 *
 * Written as a factual note rather than a warning banner. It is a real
 * limitation and not an incident, and copy that shouts would be read as "this
 * product is broken" by somebody whose knowledge base is working fine.
 */
export function floorNotice(): FloorNotice {
  if (FLOOR.status === "measured") {
    return {
      headline: null,
      detail:
        `Verse answers from a passage only when it scores at least ` +
        `${FLOOR.value}. Measured on ${FLOOR.setAt} against ${FLOOR.questionSet}.`,
    };
  }

  return {
    headline: "Provisional threshold — not yet measured",
    detail:
      `Verse answers from a passage only when it scores at least ${FLOOR.value} ` +
      "for similarity to the question, and hands over to a person otherwise. " +
      "That number has been reasoned about but not measured against a real " +
      "set of questions, so it may be refusing questions your documents do " +
      "answer, or answering some it should pass on.",
  };
}

/* ------------------------------------------------------------------------- *
 * Campaigns
 * ------------------------------------------------------------------------- */

export type CampaignStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "STOPPED"
  | "ARCHIVED";

export function campaignStatusLabel(status: CampaignStatus): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "SCHEDULED":
      return "Scheduled";
    case "RUNNING":
      return "Running";
    case "PAUSED":
      return "Paused";
    case "COMPLETED":
      return "Finished";
    case "STOPPED":
      return "Stopped";
    case "ARCHIVED":
      return "Archived";
  }
}

export function campaignStatusVariant(
  status: CampaignStatus,
): "default" | "outline" | "success" | "error" {
  switch (status) {
    case "RUNNING":
      return "success";
    case "STOPPED":
      return "error";
    case "PAUSED":
    case "SCHEDULED":
      return "outline";
    default:
      return "default";
  }
}

/**
 * Which controls a campaign offers.
 *
 * Derived rather than written per status at each call site, because the list
 * page and the detail page must agree - a Resume button on one and not the
 * other is a bug somebody reports as "the button is missing".
 *
 * STOPPED offers no Resume, deliberately. Meta revoked the template; resuming
 * would put the campaign straight back into refusing one message at a time,
 * and offering a control that cannot work is worse than offering none.
 */
export interface CampaignControls {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canDuplicate: boolean;
  canArchive: boolean;
}

export function campaignControls(status: CampaignStatus): CampaignControls {
  return {
    canStart: status === "DRAFT" || status === "SCHEDULED",
    canPause: status === "RUNNING",
    canResume: status === "PAUSED",
    /* Always available, including on a stopped campaign - duplicating one whose
       template Meta rejected is exactly how somebody starts again. */
    canDuplicate: status !== "ARCHIVED",
    canArchive: status !== "ARCHIVED" && status !== "RUNNING",
  };
}

/** The tenant's schedule, in one line. */
export function scheduleSummary(
  timezone: string,
  windowStart: number | null,
  windowEnd: number | null,
  dailyCap: number | null,
): string {
  const parts: string[] = [];

  if (windowStart !== null && windowEnd !== null) {
    parts.push(
      `${formatMinutes(windowStart)}–${formatMinutes(windowEnd)} ${timezone}`,
    );
  } else {
    parts.push(`Any time, ${timezone}`);
  }

  if (dailyCap !== null) {
    parts.push(`up to ${dailyCap} a day`);
  }

  return parts.join(" · ");
}

/** What the tenant sees for a tier. Never the provider, never the model. */
export function tierLabel(tier: string): string {
  return (VERSE_MODELS as Record<string, { label: string }>)[tier]?.label ?? tier;
}

export const TIER_CHOICES: ReadonlyArray<{ value: VerseTier; label: string }> = (
  ["V1", "V2", "V3"] as const
).map((tier) => ({ value: tier, label: VERSE_MODELS[tier].label }));
