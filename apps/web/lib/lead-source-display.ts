import type { RejectReason } from "@whatsapp-os/core/bulk";

/**
 * How a lead source's state is presented.
 *
 * Extracted from the pages rather than written inline, for the reason
 * number-display.ts is: a badge choice is a decision with branches, and this
 * repository has already learned that asserting a rendered substring is not a
 * test of one - a check that the markup contained "Reactivate" stayed green
 * after the control was deleted, because the word survived in a neighbouring
 * heading. These are small functions with a handful of inputs, and the tests
 * assert the returned value.
 */

/** The badge variants this module chooses between. Badge has no warning tier. */
export type StatusVariant = "success" | "error" | "default";

export type LeadSourceStatusName = "ACTIVE" | "PAUSED" | "ERROR";

export function leadStatusVariant(status: LeadSourceStatusName): StatusVariant {
  if (status === "ACTIVE") return "success";
  if (status === "ERROR") return "error";
  /* PAUSED is neutral, not an error. Somebody switched it off on purpose and
     colouring their own decision red would be the page arguing with them. */
  return "default";
}

export function leadStatusLabel(status: LeadSourceStatusName): string {
  switch (status) {
    case "ACTIVE":
      return "Polling";
    case "PAUSED":
      return "Paused";
    case "ERROR":
      return "Not reading";
  }
}

/**
 * The sentence under the badge.
 *
 * ERROR carries the stored error rather than a generic line, because the whole
 * point of this state is that the tenant can act on it - and "we cannot see
 * this sheet" and "Meta has not approved this template" need completely
 * different actions from the same person.
 */
export function leadStatusSentence(
  status: LeadSourceStatusName,
  lastError: string | null,
): string {
  switch (status) {
    case "ACTIVE":
      return "New rows are picked up automatically.";
    case "PAUSED":
      return "Switched off. Nothing is read and nothing is sent.";
    case "ERROR":
      return (
        lastError ??
        /* A binding in ERROR with no recorded reason should not happen, and is
           rendered rather than hidden - a blank explanation is how somebody
           notices something is wrong with the reporting itself. */
        "This lead source stopped reading and did not record a reason."
      );
  }
}

/**
 * What a row's outcome says in the live feed.
 *
 * Reads the message's own status where there is one, because a lead that
 * became a message is an ordinary message from that point and its status
 * ladder is the truth about whether it arrived. The row's own state only
 * answers whether we tried.
 */
export function leadRowOutcome(row: {
  state: "SENT" | "SKIPPED";
  skipReason: string | null;
  message: { status: string; errorTitle: string | null } | null;
}): { label: string; variant: StatusVariant } {
  if (row.state === "SKIPPED") {
    return { label: row.skipReason ?? "Not sent", variant: "default" };
  }

  if (!row.message) {
    /* SENT with no message is the shape a crash between the two writes would
       leave. The CHECK constraint forbids it, so seeing it means something
       else is wrong and it should be visible rather than rendered as blank. */
    return { label: "No message recorded", variant: "error" };
  }

  switch (row.message.status) {
    case "DELIVERED":
      return { label: "Delivered", variant: "success" };
    case "READ":
      return { label: "Read", variant: "success" };
    case "SENT":
      return { label: "Sent", variant: "success" };
    case "HELD":
      return { label: "Held by Meta", variant: "default" };
    case "PENDING":
      return { label: "Queued", variant: "default" };
    case "UNCONFIRMED":
      return { label: "Delivery unknown", variant: "error" };
    case "FAILED":
      return {
        label: row.message.errorTitle ?? "Failed",
        variant: "error",
      };
    default:
      return { label: row.message.status, variant: "default" };
  }
}

/**
 * The sentence beside a reject count.
 *
 * The same wording bulk's rejects file uses, from the same reason codes, so a
 * tenant who has seen one recognises the other. Reused rather than restated -
 * two wordings for one reason is how a support conversation goes wrong.
 */
export function rejectReasonLabel(reason: string): string {
  const known: Record<RejectReason, string> = {
    missing_phone: "No number in the mapped column",
    unparseable_phone: "Not a number anyone can be reached on",
    duplicate_in_file: "The same number appears earlier in the sheet",
  };

  return known[reason as RejectReason] ?? reason;
}

/** Reject reasons as a sorted list, largest first, for the report. */
export function rejectBreakdown(
  reasons: unknown,
): Array<{ reason: string; label: string; count: number }> {
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return [];

  return Object.entries(reasons as Record<string, unknown>)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([reason, count]) => ({
      reason,
      label: rejectReasonLabel(reason),
      count: count as number,
    }))
    /* Largest first, tie-broken on the reason so the order is stable run to
       run - a screenshot notices an unstable order even when a person would
       not. */
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** The link back into Google, at the tab the binding actually reads. */
export function sheetUrl(spreadsheetId: string, gid: number | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return gid === null ? base : `${base}#gid=${gid}`;
}
