"use server";

import { revalidatePath } from "next/cache";
import { JOB_NAMES } from "@whatsapp-os/core/queues";
import { VERSE_EMBEDDING } from "@whatsapp-os/core/verse";
import { deleteDocumentAndOrphanedChunks, withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { systemQueue } from "@/lib/queue";

/**
 * Everything the knowledge base screen can do.
 *
 * Every action calls requireSession() and assertFeatureAccess() itself. Rule 4:
 * the layout's check is a redirect for the user's benefit, and a server action
 * is reachable by its id whatever the page rendered.
 */

/** 10 MiB, matching the CHECK on the column. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ACCEPTED = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
]);

export interface KnowledgeState {
  error?: string;
}

export async function createKnowledgeBaseAction(
  _state: KnowledgeState,
  formData: FormData,
): Promise<KnowledgeState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) return { error: "Give the knowledge base a name." };

  await withCompany(session.companyId, (db, companyId) =>
    db.knowledgeBase.create({
      data: {
        companyId,
        name,
        /*
         * Stamped from the constant at creation, so this base records what its
         * vectors will actually come from. After a re-embedding migration the
         * constant and an older base's stamp disagree, correctly, and the
         * ingestion handler refuses to add to a base it cannot match.
         */
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
      },
    }),
  );

  revalidatePath("/ai-messaging/knowledge");
  return {};
}

/**
 * Accept a file, store its bytes, and hand the work to the worker.
 *
 * ---------------------------------------------------------------------------
 * The type is decided by the bytes, never by what the browser said
 * ---------------------------------------------------------------------------
 *
 * `file.type` is supplied by the client and is trivially wrong - a renamed
 * `.exe`, or a browser that simply guesses. The KYC upload path already
 * establishes the rule for this repository: a file is what its content says it
 * is. A PDF starts `%PDF-`, and anything claiming to be one that does not is
 * refused here rather than failing three layers down in a worker.
 */
export async function uploadDocumentAction(
  _state: KnowledgeState,
  formData: FormData,
): Promise<KnowledgeState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      error: `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is 10 MB.`,
    };
  }

  if (!ACCEPTED.has(file.type)) {
    return { error: "Only PDF and plain text files can be added." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /*
   * %PDF-, from the bytes in hand. The same check kyc_documents makes with a
   * CHECK constraint - here it is in the action because this column also holds
   * text files, so the constraint cannot be about one magic number.
   */
  if (file.type === "application/pdf") {
    const header = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
    if (header !== "%PDF-") {
      return {
        error:
          "That file is named as a PDF but its contents are not a PDF. " +
          "Re-export it and try again.",
      };
    }
  }

  const document = await withCompany(session.companyId, async (db, companyId) => {
    /* The base must be this company's. Rule 6 - a base that is not yours does
       not exist, so a missing one is an error the caller renders, never a 403. */
    const base = await db.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });

    if (!base) return null;

    return db.kbDocument.create({
      data: {
        companyId,
        knowledgeBaseId: base.id,
        kind: "FILE",
        title: file.name,
        filename: file.name,
        mimeType: file.type,
        byteSize: bytes.byteLength,
        bytes: Buffer.from(bytes),
        status: "PENDING",
      },
      select: { id: true },
    });
  });

  if (!document) return { error: "That knowledge base could not be found." };

  await systemQueue.add(JOB_NAMES.VERSE_INGEST, {
    companyId: session.companyId,
    documentId: document.id,
  });

  revalidatePath("/ai-messaging/knowledge");
  return {};
}

/** Add a URL for the crawler. */
export async function addUrlAction(
  _state: KnowledgeState,
  formData: FormData,
): Promise<KnowledgeState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "");
  const raw = String(formData.get("url") ?? "").trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "That does not look like a web address." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "Only http and https addresses can be crawled." };
  }

  const document = await withCompany(session.companyId, async (db, companyId) => {
    const base = await db.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });

    if (!base) return null;

    return db.kbDocument.create({
      data: {
        companyId,
        knowledgeBaseId: base.id,
        kind: "URL",
        title: url.host + url.pathname,
        sourceUrl: url.toString(),
        status: "PENDING",
      },
      select: { id: true },
    });
  });

  if (!document) return { error: "That knowledge base could not be found." };

  await systemQueue.add(JOB_NAMES.VERSE_INGEST, {
    companyId: session.companyId,
    documentId: document.id,
  });

  revalidatePath("/ai-messaging/knowledge");
  return {};
}

/**
 * Try a document again.
 *
 * The most common thing a tenant will do on this screen after a failure, and
 * the reason each failure carries a sentence: "the page was behind a login" is
 * something they fix and retry, and a re-index that could not be triggered
 * would make the sentence useless.
 *
 * Resets to PENDING and clears the reason, so the row does not show a stale
 * failure while it is being retried.
 */
export async function reindexDocumentAction(
  _state: KnowledgeState,
  formData: FormData,
): Promise<KnowledgeState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const documentId = String(formData.get("documentId") ?? "");

  const { count } = await withCompany(session.companyId, (db, companyId) =>
    db.kbDocument.updateMany({
      where: { id: documentId, companyId },
      data: { status: "PENDING", failureReason: null },
    }),
  );

  if (count === 0) return { error: "That document could not be found." };

  await systemQueue.add(JOB_NAMES.VERSE_INGEST, {
    companyId: session.companyId,
    documentId,
  });

  revalidatePath("/ai-messaging/knowledge");
  return {};
}

/**
 * Remove a document, and every passage that was only in it.
 *
 * A cascade alone is no longer enough, and that is the whole point of the
 * change that made chunks shared. ON DELETE CASCADE removes this document's
 * SOURCE rows; a passage it shared with another document survives, correctly,
 * and a passage that was only here is left behind with no sources at all -
 * still in the index, still retrievable, still answering customers out of a
 * document the tenant just deleted, and now citing a document that no longer
 * exists.
 *
 * deleteDocumentAndOrphanedChunks does both in one transaction. One statement
 * then another in this action would leave a window where exactly that is true.
 */
export async function deleteDocumentAction(
  _state: KnowledgeState,
  formData: FormData,
): Promise<KnowledgeState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const documentId = String(formData.get("documentId") ?? "");

  await withCompany(session.companyId, async (db, companyId) => {
    /*
     * Read the base first: orphan collection is scoped to one knowledge base,
     * and after the delete there is nothing left to ask which one. Scoped
     * rather than global so a deletion costs what the tenant deleted rather
     * than a sweep of their whole corpus.
     */
    const document = await db.kbDocument.findFirst({
      where: { id: documentId, companyId },
      select: { knowledgeBaseId: true },
    });

    if (!document) return;

    await deleteDocumentAndOrphanedChunks(db, companyId, {
      documentId,
      knowledgeBaseId: document.knowledgeBaseId,
    });
  });

  revalidatePath("/ai-messaging/knowledge");
  return {};
}
