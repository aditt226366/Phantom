import type { Metadata } from "next";
import { KYC_KINDS } from "@whatsapp-os/core/kyc";
import { currentKycDocuments, withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { CsrfField } from "@/components/ui/csrf-field";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import {
  canReplace,
  formatBytes,
  kindLabel,
  statusLabel,
  statusVariant,
} from "@/lib/kyc-display";
import { SectionHeader, SectionShell } from "../../_components/section";
import { UploadControl } from "./_components/upload-control";

export const metadata: Metadata = { title: "Documents" };

/**
 * The three documents, and where they stand.
 *
 * One of the four pages an unverified account can reach, and the only one that
 * can change that - so it is deliberately NOT behind requireFeatureAccess().
 * Gating it would be a deadlock: the way out of the blocked state runs through
 * here.
 *
 * It still calls requireSession() itself. The layout is a redirect for the
 * user's benefit, not the boundary (rule 4).
 *
 * Every row renders whatever state it is in, including the one every account
 * starts in. A page that showed nothing until a document existed would leave a
 * new tenant with no idea what is being asked of them.
 */
export default async function DocumentsPage() {
  const session = await requireSession();

  const documents = await withCompany(session.companyId, (db, companyId) =>
    currentKycDocuments(db, companyId),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Documents"
        lede="We verify every business before it can send messages. Upload all three as PDFs and we will review them, usually within one working day."
      />

      <ul className="flex flex-col gap-sm">
        {KYC_KINDS.map((kind) => {
          const document = documents[kind];
          const status = document?.status ?? null;

          return (
            <li
              key={kind}
              className="rounded-lg border border-hairline bg-surface-card px-base py-base"
            >
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="min-w-0">
                  <h2 className="text-title-sm text-ink">{kindLabel(kind)}</h2>

                  {document ? (
                    <p className="mt-xxs text-body-sm text-body">
                      {/* The filename is the tenant's own, so it is truncated
                          rather than trusted to be short - R4's automatic
                          minimum size hazard, one table over. */}
                      <span className="block truncate">
                        {document.originalFilename}
                      </span>
                      <span className="text-caption text-muted">
                        {formatBytes(document.byteSize)} · uploaded{" "}
                        {formatTimestamp(document.uploadedAt)}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-xxs text-body-sm text-body">
                      Not sent yet. PDF, up to 5 MB.
                    </p>
                  )}
                </div>

                <Badge variant={statusVariant(status)}>
                  {statusLabel(status)}
                </Badge>
              </div>

              {/*
                The rejection reason, which is the whole reason a rejection is
                worth more than a red chip. Without it the tenant knows only
                that something was wrong, and uploads the same file again.
              */}
              {status === "REJECTED" && document?.reviewNote ? (
                <p className="mt-sm rounded-md border border-hairline-strong bg-surface-strong px-base py-sm text-body-sm text-error">
                  {document.reviewNote}
                </p>
              ) : null}

              {status === "APPROVED" ? (
                <p className="mt-sm text-caption text-muted">
                  Approved {formatTimestamp(document?.reviewedAt)}. Contact
                  support if this needs to change.
                </p>
              ) : (
                <div className="mt-sm">
                  <UploadControl
                    kind={kind}
                    label={kindLabel(kind)}
                    replaceable={canReplace(status)}
                    replacing={document !== null}
                    csrf={<CsrfField />}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SectionShell>
  );
}
