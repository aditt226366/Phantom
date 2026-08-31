import type { FeatureBlock, KycKind, KycStatus } from "@whatsapp-os/core/kyc";

/**
 * How verification state is presented, on both sides of it.
 *
 * Extracted from the pages rather than written inline for the reason
 * number-display.ts gives: a badge choice is a decision with branches, and
 * asserting a rendered substring is not a test of one. A check that the markup
 * contained "Reactivate" stayed green after the control was deleted, because
 * the word survived in a neighbouring heading.
 *
 * These are small functions with a handful of inputs each, and the tests
 * assert the returned value.
 */

/** The badge variants this module chooses between. Badge has no warning tier. */
export type StatusVariant = "success" | "error" | "default" | "outline";

/** What the tenant and the operator both call each document. */
const KIND_LABELS: Record<KycKind, string> = {
  GST: "GST Certificate",
  PAN: "PAN Card",
  AADHAAR: "Aadhaar",
};

export function kindLabel(kind: KycKind): string {
  return KIND_LABELS[kind];
}

/**
 * What one document's chip says.
 *
 * Null is a state, not a missing value: "Not uploaded" is the most common
 * thing this page renders, because it is where every account starts.
 */
export function statusLabel(status: KycStatus | null): string {
  switch (status) {
    case null:
      return "Not uploaded";
    case "PENDING":
      return "In review";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
  }
}

/**
 * The chip's colour.
 *
 * Not-uploaded is `outline` rather than `error`. Nothing has gone wrong when
 * an account has not filed a document yet - it is simply the next thing to do
 * - and painting three red chips on a new tenant's first visit tells them they
 * have already failed at something.
 */
export function statusVariant(status: KycStatus | null): StatusVariant {
  switch (status) {
    case "APPROVED":
      return "success";
    case "REJECTED":
      return "error";
    case "PENDING":
      return "default";
    case null:
      return "outline";
  }
}

/**
 * May the tenant replace this document?
 *
 * Locked once approved, and that is the only lock. A tenant re-uploading over
 * an approval would silently un-verify their own account - the new row is
 * PENDING, the gate closes, and nothing they did looked like turning the
 * product off. Pending and rejected are both replaceable: waiting is not a
 * reason to refuse a better scan, and a rejection is an instruction to send
 * one.
 */
export function canReplace(status: KycStatus | null): boolean {
  return status !== "APPROVED";
}

/**
 * What the blocked state says, per reason.
 *
 * The sentence is produced here rather than in canUseFeatures, which returns
 * machine codes for the reason send-policy.ts sets out: a refusal travels, and
 * prose gets matched on eventually.
 *
 * Each one says what is wrong and what to do next. A blocked page that only
 * names its own state sends the reader to support, which is the outcome the
 * whole designed state exists to avoid.
 */
export interface BlockedCopy {
  title: string;
  description: string;
  /** Whether Profile > Documents is worth offering. Not for a suspension. */
  showDocumentsLink: boolean;
}

const BLOCKED_COPY: Record<FeatureBlock, BlockedCopy> = {
  company_deactivated: {
    title: "This workspace is suspended",
    description:
      "Nothing can be sent or changed while a workspace is suspended. Your data is intact. Contact support to discuss reactivating it.",
    /* Documents are irrelevant here, and pointing at them would send somebody
       to upload paperwork that will not lift the suspension. */
    showDocumentsLink: false,
  },
  documents_missing: {
    title: "Verify your business to continue",
    description:
      "We need your GST certificate, PAN card and Aadhaar before this workspace can send messages or run campaigns. Upload all three and we will review them.",
    showDocumentsLink: true,
  },
  documents_rejected: {
    title: "One of your documents needs replacing",
    description:
      "We could not accept one of the documents you sent. The reason is on the Documents page, along with a way to upload a new one.",
    showDocumentsLink: true,
  },
  documents_pending: {
    title: "Your documents are being reviewed",
    description:
      "All three are with us and nothing more is needed from you. We will email you as soon as the review is finished, usually within one working day.",
    showDocumentsLink: true,
  },
};

export function blockedCopy(reason: FeatureBlock): BlockedCopy {
  return BLOCKED_COPY[reason];
}

/**
 * A file size a person can read.
 *
 * Binary units, matching the cap: the limit is 5 MiB and rendering a 5 MiB
 * file as "5.2 MB" beside a rule that says 5 MB is a support conversation
 * nobody needs to have.
 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
