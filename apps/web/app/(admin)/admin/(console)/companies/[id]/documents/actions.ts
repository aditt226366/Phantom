"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertAdminCsrf, requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import {
  decideKycDocument,
  deleteCompanyKycDocuments,
  getCompanyDetail,
  getKycDocument,
  writeAdminAudit,
} from "@/lib/admin-db";

/**
 * The three verdicts an operator can record on a document.
 *
 * Approve, reject and revoke - and revoke writes REJECTED, because that is
 * what a withdrawn approval means to everybody downstream: not accepted, here
 * is why, send another. The database enum stays at three members and the gate
 * keeps one way to spell a closed door.
 *
 * What is NOT collapsed is the record. admin_audit_log gets a distinct action
 * for a revocation, because "this was never accepted" and "we accepted this
 * and later changed our minds" are different events, and the second is the one
 * an incident review is looking for.
 */

/**
 * Every decision is guarded on the status the operator was looking at.
 *
 * Two operators opening the same document and both clicking is an ordinary
 * race in a panel several people share. Without the guard the second write
 * silently overwrites the first verdict, and the audit log shows two decisions
 * with no indication that one of them lost. With it, the second is a no-op
 * that can be reported.
 */
async function decide(
  formData: FormData,
  input: {
    status: "APPROVED" | "REJECTED";
    action: string;
    /** Required for everything except an approval. */
    requireNote: boolean;
  },
): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const documentId = formData.get("documentId")?.toString() ?? "";
  const note = formData.get("reviewNote")?.toString().trim() ?? "";

  const document = await getKycDocument(documentId);
  if (!document) return;

  /*
   * A rejection or a revocation with no reason is a dead end wearing a status
   * chip: the tenant is told to send another document and not what was wrong
   * with this one, so they send the same one again. The form marks the field
   * required; this is the half that a POST cannot skip.
   */
  if (input.requireNote && note.length === 0) return;

  const landed = await decideKycDocument({
    documentId,
    status: input.status,
    reviewNote: note.length > 0 ? note.slice(0, 500) : null,
    adminUserId: session.adminUserId,
    expectedStatus: document.status,
  });

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: input.action,
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: {
      documentId,
      companyId: document.companyId,
      kind: document.kind,
      from: document.status,
      to: input.status,
      /* False means another operator got there first. Recorded rather than
         dropped: a decision that did not land is still a decision somebody
         made, and its absence from the log would be the confusing part. */
      applied: landed,
    },
  });

  const path = `/admin/companies/${document.companyId}/documents`;
  revalidatePath(path);
  redirect(path);
}

export async function approveDocumentAction(formData: FormData): Promise<void> {
  await decide(formData, {
    status: "APPROVED",
    action: "admin.kyc.document.approved",
    /* An approval needs no explanation. Requiring one would be busywork on the
       path an operator walks dozens of times a day. */
    requireNote: false,
  });
}

export async function rejectDocumentAction(formData: FormData): Promise<void> {
  await decide(formData, {
    status: "REJECTED",
    action: "admin.kyc.document.rejected",
    requireNote: true,
  });
}

/**
 * Withdraw an approval.
 *
 * The case that proves canUseFeatures is read on every request rather than
 * decided at sign-in: the gate closes again, mid-session, for a tenant who was
 * working normally a moment ago.
 *
 * A reason is required here as it is for a rejection, and for a sharper
 * version of the same argument. A tenant whose account stops working is owed
 * an explanation more than one whose upload was refused - they had it, and now
 * they do not.
 */
export async function revokeDocumentAction(formData: FormData): Promise<void> {
  await decide(formData, {
    status: "REJECTED",
    action: "admin.kyc.document.revoked",
    requireNote: true,
  });
}

/**
 * Erase every KYC document a company has filed. Permanently.
 *
 * ---------------------------------------------------------------------------
 * DPDP makes this a requirement, not a nicety
 * ---------------------------------------------------------------------------
 *
 * India's Digital Personal Data Protection Act gives a Data Principal the
 * right to erasure and obliges a Data Fiduciary to delete personal data once
 * the purpose it was collected for is served. An Aadhaar card is as squarely
 * inside that as personal data gets.
 *
 * So the path exists before anybody asks for it. The alternative is writing it
 * under a deadline against production, which is how the wrong company's
 * documents get deleted.
 *
 * ---------------------------------------------------------------------------
 * Why the friction, and why more than Deactivate has
 * ---------------------------------------------------------------------------
 *
 * Deactivate is reversible and has a confirm step. This is not reversible and
 * it destroys the evidence that verification ever happened - the append-only
 * table exists precisely to keep that, and this is the one operation allowed
 * to contradict it.
 *
 * So the operator types the company's name. A confirm step alone protects
 * against a misclick; typing the name is what protects against confirming the
 * wrong company, which is the mistake that actually happens when two tabs are
 * open. The comparison is exact and trimmed, never fuzzy - a near-match that
 * proceeded would defeat the entire control.
 *
 * The gate closes as a side effect and that is correct rather than incidental:
 * a company whose documents are gone is a company nobody has verified, and it
 * should be blocked until it files again.
 */
export async function eraseCompanyDocumentsAction(
  formData: FormData,
): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const companyId = formData.get("companyId")?.toString() ?? "";
  const typed = formData.get("confirmName")?.toString().trim() ?? "";

  const company = await getCompanyDetail(companyId);
  if (!company) return;

  if (typed !== company.name.trim()) {
    /*
     * Silently back to the tab rather than an error message. There is nothing
     * useful to say - the operator can see the name on screen - and a page
     * reporting "that is not the name" is one somebody retries against until
     * it works, which is the behaviour this control exists to prevent.
     *
     * `return redirect(...)` rather than a bare call. redirect() is typed
     * `never` and throws in Next, so the bare version is correct today and
     * depends on that throw for its control flow - which is a dangerous thing
     * to depend on for the line that stands between an operator and an
     * irreversible delete. Written this way it refuses even if redirect were
     * ever to return.
     */
    return redirect(`/admin/companies/${companyId}/documents?confirm=erase`);
  }

  const removed = await deleteCompanyKycDocuments(companyId);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.kyc.documents.erased",
    ...(context.ip ? { ip: context.ip } : {}),
    /*
     * The count and the company, which is all that is left to record. The
     * documents are gone; this row is the only remaining evidence that they
     * existed and who removed them - so it is written after the delete, when
     * the number is a fact rather than an intention.
     */
    metadata: { companyId, documentsRemoved: removed },
  });

  revalidatePath(`/admin/companies/${companyId}/documents`);
  redirect(`/admin/companies/${companyId}/documents`);
}
