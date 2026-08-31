"use server";

import { revalidatePath } from "next/cache";
import { KYC_KINDS, type KycKind } from "@whatsapp-os/core/kyc";
import { readPdfUpload, type UploadRejection } from "@whatsapp-os/core/kyc-server";
import { currentKycDocuments, putKycDocument, withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { canReplace, kindLabel } from "@/lib/kyc-display";

/**
 * Filing a verification document.
 *
 * ---------------------------------------------------------------------------
 * This action is NOT behind the feature gate, and that is the point
 * ---------------------------------------------------------------------------
 *
 * A4 blocks everything except four things, and this is one of them. Gating the
 * upload on being verified would be a deadlock: the only way out of the
 * blocked state is through this action, so a tenant who could not reach it
 * would have no route to verification at all.
 *
 * It still calls requireSession() itself - rule 4 - because the layout is not
 * an authorization boundary. What it does not call is requireFeatureAccess().
 */

export interface UploadDocumentState {
  message?: string;
  success?: string;
}

/** Why an upload was refused, as a sentence the uploader can act on. */
const REJECTION_SENTENCES: Record<UploadRejection, string> = {
  empty: "No file was attached. Choose a PDF and try again.",
  not_a_pdf:
    "That file is not a PDF. Renaming a photograph or a scan to .pdf does not convert it - export or scan it as a PDF and upload that.",
  too_large:
    "That file is larger than 5 MB. Scan at a lower resolution, or use a PDF compressor, and upload it again.",
  read_failed:
    "The upload did not finish. That is usually a connection problem rather than anything wrong with the file, so it is worth trying again.",
};

export async function uploadKycDocumentAction(
  _previous: UploadDocumentState,
  formData: FormData,
): Promise<UploadDocumentState> {
  /* Its own check, not the layout's - see rule 4 in CLAUDE.md. */
  const session = await requireSession();
  await assertCsrf(formData, session);

  const kind = formData.get("kind");

  /*
   * Validated against the closed list rather than cast. The value comes from a
   * hidden input, which is to say from the client, and an unchecked cast would
   * hand an arbitrary string to an enum column - a 500 from a query error
   * rather than a refusal.
   */
  if (typeof kind !== "string" || !isKycKind(kind)) {
    return { message: "That is not a document we collect." };
  }

  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { message: REJECTION_SENTENCES.empty };
  }

  /*
   * Refuse a replacement of an approved document before reading a byte.
   *
   * The rule is in canReplace and is shared with the page that renders the
   * control, so the button and the action cannot disagree about what is
   * locked. This is the half that matters: the page hiding a control is a
   * convenience, and a POST does not have to come from the page.
   *
   * Why locked at all - a re-upload over an approval would silently
   * un-verify the account. The new row is PENDING, the gate shuts, and nothing
   * the tenant did looked like turning the product off.
   */
  const current = await withCompany(session.companyId, (db, companyId) =>
    currentKycDocuments(db, companyId),
  );

  if (!canReplace(current[kind]?.status ?? null)) {
    return {
      message: `Your ${kindLabel(kind)} is already approved and cannot be replaced. Contact support if it needs to change.`,
    };
  }

  /*
   * Read and validate OUTSIDE withCompany. The callback holds a pooled
   * connection and times out after five seconds; a 5 MB read and a sha256 over
   * it have no business inside a transaction.
   */
  const upload = await readPdfUpload(file.stream());

  if (!upload.ok) {
    return { message: REJECTION_SENTENCES[upload.reason] };
  }

  await withCompany(session.companyId, (db, companyId) =>
    putKycDocument(db, companyId, {
      kind,
      bytes: upload.bytes,
      sha256: upload.sha256,
      /*
       * Our finding, not the browser's. file.type is whatever the client
       * volunteered and readPdfUpload has just established what this actually
       * is, so storing the claim rather than the finding would put a
       * contradiction in the row and hand it to the download route as a
       * Content-Type.
       */
      mimeType: "application/pdf",
      /*
       * The name as given, stored raw and deliberately. It is a record of what
       * the tenant sent, and sanitising on the way in would leave the row
       * disagreeing with their filesystem. Every render and every header
       * sanitises on the way out instead, which is the only place it matters.
       */
      originalFilename: file.name.slice(0, 255),
    }),
  );

  /*
   * The page is what reports the new state, so it has to re-render - the
   * convention since Phase 2 for any mutation that does not redirect. Without
   * it the row keeps its old chip and the tenant uploads again.
   */
  revalidatePath("/profile/documents");

  return {
    success: `${kindLabel(kind)} uploaded. We will review it and let you know.`,
  };
}

function isKycKind(value: string): value is KycKind {
  return (KYC_KINDS as readonly string[]).includes(value);
}
