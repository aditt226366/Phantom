import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/format";
import { formatBytes } from "@/lib/kyc-display";
import type { AdminKycDocument } from "@/lib/admin-db";

/**
 * One uploaded document, with whatever the operator can do to it.
 *
 * A server component: every control is a form posting to a server action, so
 * nothing here needs state. The reject and revoke reasons are plain textareas
 * marked required - the browser enforces that for a person, and the action
 * enforces it for everything else.
 *
 * View and Download are ordinary links to the authenticated route rather than
 * fetches, so an operator's browser handles the PDF the way it handles any
 * other, and a middle click opens it in a tab.
 */

export interface KycDocumentCardProps {
  document: AdminKycDocument;
  /** True for the newest row of its kind - the one the gate actually reads. */
  current: boolean;
  csrf: ReactNode;
  approveAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
  revokeAction: (formData: FormData) => void | Promise<void>;
}

const STATUS_VARIANT: Record<string, "success" | "error" | "default"> = {
  APPROVED: "success",
  REJECTED: "error",
  PENDING: "default",
};

const KIND_LABELS: Record<string, string> = {
  GST: "GST Certificate",
  PAN: "PAN Card",
  AADHAAR: "Aadhaar",
};

export function KycDocumentCard({
  document,
  current,
  csrf,
  approveAction,
  rejectAction,
  revokeAction,
}: KycDocumentCardProps) {
  const href = `/api/admin/kyc-documents/${document.id}`;

  return (
    <article className="rounded-lg border border-hairline bg-surface-card px-base py-base">
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <h3 className="text-title-sm text-ink">
            {KIND_LABELS[document.kind] ?? document.kind}
          </h3>
          {/* The tenant's own filename, so it is truncated rather than trusted
              to be short. */}
          <p className="mt-xxs truncate text-body-sm text-body">
            {document.originalFilename}
          </p>
          <p className="text-caption text-muted">
            {formatBytes(document.byteSize)} · uploaded{" "}
            {formatTimestamp(document.uploadedAt)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-xs">
          {/*
            Superseded rows stay visible, because the append-only table exists
            so that what was approved survives a replacement. Saying which row
            is current is what stops an operator reading a verdict off a
            document the tenant replaced a month ago.
          */}
          {current ? null : <Badge variant="outline">Superseded</Badge>}
          <Badge variant={STATUS_VARIANT[document.status] ?? "default"}>
            {document.status}
          </Badge>
        </div>
      </div>

      {document.reviewNote ? (
        <p className="mt-sm rounded-md border border-hairline-strong bg-surface-strong px-base py-sm text-body-sm text-body">
          {document.reviewNote}
        </p>
      ) : null}

      {document.reviewedAt ? (
        <p className="mt-xs text-caption text-muted">
          {document.status === "APPROVED" ? "Approved" : "Rejected"}{" "}
          {formatTimestamp(document.reviewedAt)}
          {document.reviewedByUsername
            ? ` by ${document.reviewedByUsername}`
            : null}
        </p>
      ) : null}

      <div className="mt-base flex flex-wrap items-center gap-xs">
        <Button asChild variant="outline" size="sm">
          {/* Not a Link: typedRoutes types the app's own routes, and an
              /api path with a query string is not one of them. */}
          <a href={href} target="_blank" rel="noreferrer">
            View
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`${href}?download=1`}>Download</a>
        </Button>

        {/*
          The decision controls, and only on the current row. A verdict on a
          superseded upload would change nothing the gate reads and would put
          a second, contradictory decision in the audit trail.
        */}
        {current && document.status !== "APPROVED" ? (
          <form action={approveAction} className="contents">
            {csrf}
            <input type="hidden" name="documentId" value={document.id} />
            <Button type="submit" size="sm">
              Approve
            </Button>
          </form>
        ) : null}
      </div>

      {/*
        Revocation is behind a disclosure, and reject below is not.

        Rejecting is the ordinary next step on a document awaiting review, so
        it is on screen. Revoking is rare and destructive - it locks a working
        tenant out mid-session - and an always-open form for it on every
        approved card would put the most dangerous control on the page three
        times, at rest, next to nothing else. The same reasoning that gives
        Deactivate its own confirm step.

        <details> rather than client state: it works with no JavaScript, like
        every other control in this panel.
      */}
      {current && document.status === "APPROVED" ? (
        <details className="mt-base">
          <summary className="cursor-pointer text-caption-uppercase uppercase text-muted">
            Revoke this approval
          </summary>

          <form action={revokeAction} className="mt-xs flex flex-col gap-xs">
            {csrf}
            <input type="hidden" name="documentId" value={document.id} />
            <label
              htmlFor={`revoke-${document.id}`}
              className="text-body-sm text-body"
            >
              The tenant is locked out of every feature until they replace it.
            </label>
            <textarea
              id={`revoke-${document.id}`}
              name="reviewNote"
              required
              rows={2}
              placeholder="Why is this no longer accepted? The tenant reads this."
              className="w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
            />
            <div>
              <Button type="submit" variant="outline" size="sm">
                Revoke approval
              </Button>
            </div>
          </form>
        </details>
      ) : null}

      {current && document.status !== "APPROVED" ? (
        <form action={rejectAction} className="mt-base flex flex-col gap-xs">
          {csrf}
          <input type="hidden" name="documentId" value={document.id} />
          <label
            htmlFor={`reject-${document.id}`}
            className="text-caption-uppercase uppercase text-muted"
          >
            Reject with a reason
          </label>
          <textarea
            id={`reject-${document.id}`}
            name="reviewNote"
            required
            rows={2}
            placeholder="What is wrong with it, and what should they send instead?"
            className="w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
          />
          <div>
            <Button type="submit" variant="outline" size="sm">
              Reject
            </Button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
