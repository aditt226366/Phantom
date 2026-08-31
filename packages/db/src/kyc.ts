import { KYC_KINDS, type KycKind, type KycStatuses } from "@whatsapp-os/core/kyc";
import type { KycDocumentKind, KycDocumentStatus } from "./generated/prisma/enums.ts";
import { withCompany, type CompanyClient } from "./with-company.ts";

/**
 * Business verification documents: reading the current state, and the bytes.
 *
 * The storage half is deliberately the MediaStore pattern rather than the
 * MediaStore table - see the migration for why the two must not share rows.
 * What is copied is the shape: bytea behind a narrow interface, a CHECK on
 * length, and a chunked read so a download never materialises 5 MB inside a
 * request.
 *
 * The reading half is the part with no equivalent, and it exists because
 * kyc_documents is append-only. There is no "the GST document" row - there is
 * the newest row of kind GST - and that ordering is written down once, here.
 * Every caller that re-derived it would be one `orderBy` away from showing an
 * operator a document the tenant replaced a month ago.
 *
 * ---------------------------------------------------------------------------
 * Why readKycDocument takes a companyId and the rest take a CompanyClient
 * ---------------------------------------------------------------------------
 *
 * The same asymmetry media-store.ts has, for the same reason, restated because
 * it reads like an inconsistency until you know.
 *
 * stat and the list reads are single statements and belong inside whatever
 * transaction the caller already holds. A stream does not: it is consumed at
 * the client's pace, over seconds, long after the request's transaction should
 * have ended, and holding one open for that pins a pooled connection to a slow
 * download. So the read opens its own short scope per chunk.
 */

/*
 * The vocabulary comes from @whatsapp-os/core/kyc, not from the Prisma enum.
 *
 * The order the three are rendered in is a product decision, and the gate that
 * decides on their statuses is pure and lives in core. Re-declaring the list
 * here would give the database's opinion of the ordering and the gate's a way
 * to diverge, which is the kind of drift nobody sees until a page lists them
 * one way and a blocked state another.
 */
export { KYC_KINDS };
export type { KycKind };

/** 5 MiB, matching the CHECK constraint and the upload cap exactly. */
export const MAX_KYC_DOCUMENT_BYTES = 5 * 1024 * 1024;

/**
 * One upload, without its bytes.
 *
 * Everything a page or an admin decision needs, and nothing that would put an
 * identity document into a server component's props. The bytes leave through
 * exactly one function in this file.
 */
export interface KycDocumentStat {
  id: string;
  kind: KycKind;
  status: KycDocumentStatus;
  sha256: string;
  mimeType: string;
  /** What the browser called it. Recorded, never trusted - sanitise on output. */
  originalFilename: string;
  byteSize: number;
  uploadedAt: Date;
  reviewedAt: Date | null;
  /** Why it was refused, or why an approval was withdrawn. */
  reviewNote: string | null;
}

/** The newest upload of each kind, with null for one never filed. */
export type CurrentKycDocuments = Record<KycKind, KycDocumentStat | null>;

/*
 * Selected column by column rather than with a spread, so that adding a column
 * to the table does not silently widen what every caller receives. `bytes` is
 * the one that matters: it is in the model, and a select that grew by accident
 * would load 5 MB into a page's props.
 */
const STAT_COLUMNS = {
  id: true,
  kind: true,
  status: true,
  sha256: true,
  mimeType: true,
  originalFilename: true,
  byteSize: true,
  createdAt: true,
  reviewedAt: true,
  reviewNote: true,
} as const;

interface StatRow {
  id: string;
  kind: KycDocumentKind;
  status: KycDocumentStatus;
  sha256: string;
  mimeType: string;
  originalFilename: string;
  byteSize: number;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
}

function toStat(row: StatRow): KycDocumentStat {
  return {
    id: row.id,
    kind: row.kind as KycKind,
    status: row.status,
    sha256: row.sha256,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    byteSize: row.byteSize,
    uploadedAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
  };
}

/**
 * The state of each kind for one company: the newest row, or null.
 *
 * Fetched in one query and reduced here rather than with Prisma's `distinct`,
 * on purpose. How `distinct` interacts with `orderBy` is worth neither reading
 * up on nor depending on for a decision this important - the result of this
 * function is what the feature gate opens on. Ordering by created_at
 * descending and keeping the first sighting of each kind is something anyone
 * can check by eye.
 *
 * The row count is bounded by how many times a company has re-uploaded, which
 * is single digits in every real case, and the index on
 * (company_id, kind, created_at DESC) serves the ordering.
 */
export async function currentKycDocuments(
  db: CompanyClient,
  companyId: string,
): Promise<CurrentKycDocuments> {
  const rows = await db.kycDocument.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: STAT_COLUMNS,
  });

  return newestByKind(rows as StatRow[], toStat);
}

/**
 * The newest row of each kind, given rows already ordered newest first.
 *
 * Shared by both reads below it, and that sharing is the point: the gate opens
 * on what this returns, and two implementations of "which row is current" is
 * how a page comes to show one document while the gate decides on another.
 */
function newestByKind<Row extends { kind: KycDocumentKind }, Out>(
  rows: Row[],
  map: (row: Row) => Out,
): Record<KycKind, Out | null> {
  const current = { GST: null, PAN: null, AADHAAR: null } as Record<
    KycKind,
    Out | null
  >;

  for (const row of rows) {
    const kind = row.kind as KycKind;
    /* First sighting wins, because the list is newest first. */
    if (current[kind] === null) current[kind] = map(row);
  }

  return current;
}

/**
 * The same reduction, selecting two columns instead of ten.
 *
 * This is what the send path reads, and it runs once per outbound message -
 * including every message of a Phase 5 bulk run. currentKycDocuments would
 * answer identically and carry eight columns per historical row to do it,
 * which is waste on the one path where it is measured.
 *
 * Both go through newestByKind, so the two cannot disagree about which row is
 * current. That is the property worth having; the column list is just cost.
 */
export async function currentKycStatuses(
  db: CompanyClient,
  companyId: string,
): Promise<KycStatuses> {
  const rows = await db.kycDocument.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: { kind: true, status: true },
  });

  return newestByKind(rows, (row) => row.status);
}

/** Every upload of every kind, newest first. What the admin's tab reads. */
export async function listKycDocuments(
  db: CompanyClient,
  companyId: string,
): Promise<KycDocumentStat[]> {
  const rows = await db.kycDocument.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: STAT_COLUMNS,
  });

  return rows.map((row) => toStat(row as StatRow));
}

/** One upload by id, or null when it is not this company's. Never the bytes. */
export async function statKycDocument(
  db: CompanyClient,
  companyId: string,
  documentId: string,
): Promise<KycDocumentStat | null> {
  /*
   * findFirst rather than findUnique: the extension merges companyId - a
   * non-unique column - into `where`, which findUnique's where type does not
   * accept. Same primary-key plan either way.
   *
   * Null for "not yours" as much as for "does not exist", and the caller
   * renders 404 for both. Rule 6: a 403 would confirm the row.
   */
  const row = await db.kycDocument.findFirst({
    where: { id: documentId, companyId },
    select: STAT_COLUMNS,
  });

  return row ? toStat(row as StatRow) : null;
}

export interface KycDocumentUpload {
  kind: KycKind;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  mimeType: string;
  originalFilename: string;
}

/**
 * File one upload. Always an INSERT - see the migration.
 *
 * No upsert and no dedupe, which is the whole difference from mediaStore.put:
 * a re-upload after a rejection is a new attempt owed its own verdict, and the
 * row an operator approved has to stay readable afterwards.
 */
export async function putKycDocument(
  db: CompanyClient,
  companyId: string,
  input: KycDocumentUpload,
): Promise<string> {
  const row = await db.kycDocument.create({
    data: {
      companyId,
      kind: input.kind,
      bytes: input.bytes,
      byteSize: input.bytes.byteLength,
      sha256: input.sha256,
      mimeType: input.mimeType,
      originalFilename: input.originalFilename,
    },
    select: { id: true },
  });

  return row.id;
}

/**
 * 512 KiB, for the arithmetic media-store.ts sets out in full.
 *
 * Each chunk is its own transaction and therefore its own pool checkout, and
 * DATABASE_POOL_MAX defaults to 10 for the whole runtime. At 512 KiB the 5 MiB
 * worst case is ten round trips rather than twenty. A scanned certificate is
 * usually one read with no loop at all.
 */
const CHUNK_BYTES = 512 * 1024;

/**
 * The stream ended before byte_size bytes had been emitted.
 *
 * Raised into the stream rather than returned: by the time it happens the
 * response headers are long gone, so there is no status code left to change.
 * Ending quietly would hand the client a truncated PDF under a 200 that
 * already promised Content-Length bytes.
 */
export class KycDocumentTruncatedError extends Error {
  constructor(documentId: string, emitted: number, expected: number) {
    super(
      `kyc document ${documentId} ended after ${emitted} of ${expected} bytes; ` +
        `the row was deleted or became invisible mid-stream`,
    );
    this.name = "KycDocumentTruncatedError";
  }
}

/**
 * One slice of the column, in its own short transaction.
 *
 * substring() on a bytea is a server-side slice only because the column is
 * STORAGE EXTERNAL: TOAST can fetch part of an uncompressed out-of-line value
 * without detoasting the whole thing. Under the default EXTENDED the value is
 * compressed and every slice decompresses from the start, which turns this
 * loop into N full reads while still looking like streaming.
 *
 * That setting is invisible to `migrate diff`, so what keeps it true is the
 * OUT_OF_BAND_DDL sweep. If that entry is ever removed, this is the reason to
 * put it back.
 *
 * Postgres substring is 1-based; offset is not.
 */
async function readChunk(
  companyId: string,
  documentId: string,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
  const rows = await withCompany(companyId, (db) =>
    db.$queryRaw<Array<{ chunk: Uint8Array | null }>>`
      SELECT substring(bytes from ${offset + 1} for ${length}) AS chunk
        FROM kyc_documents
       WHERE id = ${documentId}`,
  );

  return rows[0]?.chunk ?? null;
}

/**
 * The bytes, as a stream. Null when the id is unknown to this company.
 *
 * This is the ONLY way a KYC document's content leaves the database. Nothing
 * else selects the column: not a page loader, not a server action's return
 * value, not a log line. An Aadhaar card is the most sensitive thing this
 * system holds, and the number of places it can escape from is a number worth
 * keeping at one.
 */
export async function readKycDocument(
  companyId: string,
  documentId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const meta = await withCompany(companyId, (db) =>
    statKycDocument(db, companyId, documentId),
  );

  if (!meta) return null;

  const { byteSize } = meta;

  /*
   * The common case, kept out of the loop deliberately: a scanned certificate
   * is usually under 512 KiB, so it is one read and one pool checkout. Folding
   * this back into the loop would cost a second query per download to discover
   * there is nothing left.
   */
  if (byteSize <= CHUNK_BYTES) {
    const only = await readChunk(companyId, documentId, 0, byteSize);

    if (!only || only.byteLength !== byteSize) return null;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(only);
        controller.close();
      },
    });
  }

  let offset = 0;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (offset >= byteSize) {
          controller.close();
          return;
        }

        const chunk = await readChunk(
          companyId,
          documentId,
          offset,
          Math.min(CHUNK_BYTES, byteSize - offset),
        );

        /*
         * The row vanished, or stopped being visible, between chunks - a hard
         * delete, or a company deactivated mid-download. Erroring destroys the
         * stream, which breaks the transfer visibly. A failed download the
         * operator can retry beats a silently corrupt PDF they cannot detect.
         */
        if (!chunk || chunk.byteLength === 0) {
          controller.error(
            new KycDocumentTruncatedError(documentId, offset, byteSize),
          );
          return;
        }

        offset += chunk.byteLength;
        controller.enqueue(chunk);

        /* A short read is the same failure arriving one chunk earlier. */
        if (offset < byteSize && chunk.byteLength < CHUNK_BYTES) {
          controller.error(
            new KycDocumentTruncatedError(documentId, offset, byteSize),
          );
        }
      },
    },
    /* highWaterMark 0: never read ahead. One read() is one chunk is one short
       transaction, and nothing is fetched for a client that has disconnected. */
    { highWaterMark: 0 },
  );
}
