import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KYC_KINDS, canUseFeatures, type KycStatus } from "@whatsapp-os/core/kyc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getCompanyDetail,
  listCompanyKycDocuments,
  writeAdminAudit,
} from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { blockedCopy, kindLabel } from "@/lib/kyc-display";
import { AdminCsrfField } from "../../../../_components/admin-csrf-field";
import { KycDocumentCard } from "../../../../_components/kyc-document-card";
import {
  approveDocumentAction,
  eraseCompanyDocumentsAction,
  rejectDocumentAction,
  revokeDocumentAction,
} from "./actions";

export const metadata: Metadata = { title: "Documents" };

/**
 * Every document a company has filed, and the decision on each.
 *
 * The whole history, not just the current three. kyc_documents is append-only
 * precisely so that what an operator approved survives the tenant replacing
 * it, and a page that showed only the newest row would throw away the reason
 * the table is shaped that way. Superseded rows are labelled, so nobody reads
 * a verdict off a document that no longer counts.
 *
 * The banner at the top is the same verdict the tenant's product is gated on,
 * from the same function - not a second opinion assembled here. An operator
 * looking at three green chips while the tenant is locked out is the exact
 * confusion that costs a support call, and it is what two implementations of
 * "is this company verified" would produce.
 */
export default async function CompanyDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminSession();
  const context = await requestContext();

  const { id } = await params;
  const company = await getCompanyDetail(id);
  if (!company) notFound();

  const documents = await listCompanyKycDocuments(company.id);
  const confirming = (await searchParams)["confirm"] === "erase";

  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.kyc.documents.view",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { companyId: company.id, documentCount: documents.length },
  });

  /*
   * The newest row per kind, which is what the gate reads. Derived from the
   * same newest-first ordering packages/db uses, over the same rows.
   */
  const currentByKind = new Map<string, string>();
  for (const document of documents) {
    if (!currentByKind.has(document.kind)) {
      currentByKind.set(document.kind, document.id);
    }
  }

  const statuses = Object.fromEntries(
    KYC_KINDS.map((kind) => [
      kind,
      (documents.find((document) => document.id === currentByKind.get(kind))
        ?.status ?? null) as KycStatus | null,
    ]),
  ) as Record<(typeof KYC_KINDS)[number], KycStatus | null>;

  const access = canUseFeatures({
    companyDeactivated: company.deactivatedAt !== null,
    documents: statuses,
  });

  return (
    <div className="flex flex-col gap-lg">
      <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
        <div className="flex flex-wrap items-center justify-between gap-sm">
          <div>
            <h2 className="text-title-sm text-ink">
              {access.allowed
                ? "Verified — every feature is open"
                : blockedCopy(access.reason).title}
            </h2>
            <p className="mt-xxs text-body-sm text-body">
              {access.allowed
                ? "All three documents are approved, so this workspace can send messages and run campaigns."
                : blockedCopy(access.reason).description}
            </p>
          </div>
          <Badge variant={access.allowed ? "success" : "default"}>
            {access.allowed ? "Verified" : "Blocked"}
          </Badge>
        </div>

        {/* A row per kind, so a document never filed is as visible as one that
            was. Absence is the thing an operator is chasing. */}
        <ul className="mt-base flex flex-wrap gap-sm">
          {KYC_KINDS.map((kind) => (
            <li key={kind} className="flex items-center gap-xxs">
              <span className="text-body-sm text-body">{kindLabel(kind)}</span>
              <Badge
                variant={
                  statuses[kind] === "APPROVED"
                    ? "success"
                    : statuses[kind] === "REJECTED"
                      ? "error"
                      : "outline"
                }
              >
                {statuses[kind] ?? "NOT UPLOADED"}
              </Badge>
            </li>
          ))}
        </ul>
      </section>

      {documents.length === 0 ? (
        <EmptyState
          tone="peach"
          title="Nothing filed yet"
          description="This company has not uploaded any verification documents. Until all three are approved it cannot use any feature, so there is nothing to review and nothing to chase — the next move is theirs."
        />
      ) : (
        <ul className="flex flex-col gap-sm">
          {documents.map((document) => (
            <li key={document.id}>
              <KycDocumentCard
                document={document}
                current={currentByKind.get(document.kind) === document.id}
                /*
                 * One element, rendered inside each of the card's forms.
                 *
                 * That is safe where the shell's two separate instances were
                 * necessary: the rule is that one form may not carry two
                 * fields of the same name, and these are different forms. A
                 * React element is an immutable description, so rendering it
                 * in each produces a field in each.
                 */
                csrf={<AdminCsrfField />}
                approveAction={approveDocumentAction}
                rejectAction={rejectDocumentAction}
                revokeAction={revokeDocumentAction}
              />
            </li>
          ))}
        </ul>
      )}

      {/*
        Erasure, and only ever behind the confirm step.

        A GET renders the panel; only the form inside it mutates - the same
        shape Deactivate uses, for the same reason. The link is at the bottom
        and reads plainly rather than shouting: it is a legal obligation an
        operator carries out on request, not an escape hatch for a bad upload.
      */}
      {documents.length > 0 ? (
        confirming ? (
          <EraseConfirm
            companyId={company.id}
            companyName={company.name}
            documentCount={documents.length}
          />
        ) : (
          <p className="text-body-sm text-muted">
            <Link
              href={`/admin/companies/${company.id}/documents?confirm=erase`}
              className="underline underline-offset-4"
            >
              Erase these documents permanently
            </Link>{" "}
            — for a DPDP erasure request.
          </p>
        )
      ) : null}
    </div>
  );
}

/**
 * The confirmation step for an irreversible delete.
 *
 * The operator types the company's name. Deactivate is reversible and a
 * confirm step is proportionate for it; this destroys the evidence that
 * verification ever happened, and a confirm step alone only protects against a
 * misclick. Typing the name is what protects against confirming the WRONG
 * company, which is the mistake that actually happens with two tabs open.
 */
function EraseConfirm({
  companyId,
  companyName,
  documentCount,
}: {
  companyId: string;
  companyName: string;
  documentCount: number;
}) {
  return (
    <section className="rounded-xl border border-hairline-strong bg-surface-card p-lg">
      <h2 className="font-display text-display-sm text-ink">
        Erase {documentCount} document{documentCount === 1 ? "" : "s"} for{" "}
        {companyName}?
      </h2>

      <div className="mt-sm flex max-w-2xl flex-col gap-xs text-body-sm text-body">
        <p>
          The files and every record of what was approved are deleted
          permanently. This cannot be undone and there is no copy.
        </p>
        <p>
          This workspace will be blocked from every feature until it files all
          three again — which is correct: nobody has verified it any more.
        </p>
        <p className="text-ink">
          Do this for a DPDP erasure request. Not to clear a rejected upload —
          the tenant can simply send a new one.
        </p>
      </div>

      <form action={eraseCompanyDocumentsAction} className="mt-lg flex flex-col gap-xs">
        <AdminCsrfField />
        <input type="hidden" name="companyId" defaultValue={companyId} />

        <label htmlFor="confirm-name" className="text-body-sm text-body">
          Type <span className="text-ink">{companyName}</span> to confirm.
        </label>
        <input
          id="confirm-name"
          name="confirmName"
          required
          autoComplete="off"
          className="max-w-narrow rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
        />

        <div className="mt-sm flex items-center gap-sm">
          <Button type="submit">Erase permanently</Button>
          <Link
            href={`/admin/companies/${companyId}/documents`}
            className="text-body-sm text-muted underline underline-offset-4"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
