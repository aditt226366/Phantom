import { createId } from "@paralleldrive/cuid2";
import { withCompany, type CompanyClient } from "./with-company.ts";

/**
 * Where inbound media bytes live.
 *
 * One interface, one implementation. The interface is not speculative
 * generality - it is what makes the storage decision reversible. The bytes are
 * in Postgres today, which is right for now and has a named expiry (it inflates
 * every pg_dump and every base backup, so it is revisited when the table passes
 * a few GB). Without this boundary the read path would hard-code bytea and
 * moving to object storage would be a rewrite of every caller; with it, the
 * move is one new implementation plus a backfill that rewrites
 * storage_backend and storage_key. Nothing above this file knows which backend
 * it is talking to.
 *
 * ---------------------------------------------------------------------------
 * Why get() takes a companyId and the others take a CompanyClient
 * ---------------------------------------------------------------------------
 *
 * The asymmetry is deliberate and is the honest shape.
 *
 * put and stat are single statements. They belong inside whatever transaction
 * the caller already holds - the worker writing a message and its media wants
 * both or neither.
 *
 * A stream does not. It is consumed by the client at the client's pace, over
 * seconds, long after the request's transaction should have ended. Holding a
 * transaction open for that would pin a pooled connection to a slow download.
 * So get opens its own short scope per chunk and takes the company id rather
 * than a client it would have to keep alive.
 *
 * The cost of that correctness is the chunk arithmetic below.
 */

/**
 * 512 KiB.
 *
 * Each chunk is its own transaction, so it is also a pool checkout, and
 * DATABASE_POOL_MAX defaults to 10 for the whole runtime.
 *
 *   5 MiB at  64 KiB = 80 checkouts
 *   5 MiB at 256 KiB = 20 checkouts
 *   5 MiB at 512 KiB = 10 checkouts
 *
 * At 512 KiB the 5 MiB worst case is ten round trips rather than twenty, which
 * matters when several downloads are in flight against a pool of ten. Against
 * that, 512 KiB is the most that is ever resident per stream, and most WhatsApp
 * media is well under it - a photo or a voice note is usually one read with no
 * loop at all.
 *
 * Raising it trades pool pressure for memory; lowering it does the reverse.
 * Neither is free, which is why the number is here with the arithmetic rather
 * than inline.
 */
const CHUNK_BYTES = 512 * 1024;

export type MediaStateName = "PENDING" | "STORED" | "SKIPPED" | "FAILED";

export interface MediaStat {
  /** whatsapp_media.id. The handle every other method takes. */
  key: string;
  sha256: string;
  mimeType: string;
  fileName: string | null;
  byteSize: number;
  state: MediaStateName;
  /** Why there are no bytes. 'over_max_size' is expected, not an error. */
  skippedReason: string | null;
}

export interface MediaPut {
  sha256: string;
  mimeType: string;
  fileName: string | null;
  /** What the file is, whether or not the bytes were kept. */
  byteSize: number;
  /** Absent when the media was deliberately not stored. */
  bytes?: Uint8Array<ArrayBuffer>;
  /** Required when bytes are absent, so a gap always carries a reason. */
  skippedReason?: string;
}

export interface MediaStore {
  /**
   * Idempotent on (company_id, sha256). Returns the key either way, and says
   * whether the bytes were already held - the caller uses that to skip a
   * download it has not started yet.
   */
  put(
    db: CompanyClient,
    companyId: string,
    input: MediaPut,
  ): Promise<{ key: string; deduped: boolean }>;

  /** Metadata only, never the bytes. The read path calls this first. */
  stat(
    db: CompanyClient,
    companyId: string,
    key: string,
  ): Promise<MediaStat | null>;

  /**
   * The bytes, as a stream. Null when the key is unknown to this company or
   * the bytes were never stored.
   */
  get(companyId: string, key: string): Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * The stream ended before byte_size bytes had been emitted.
 *
 * Raised into the stream rather than returned, because by the time it happens
 * the response headers are long gone. See the note on readChunk below.
 */
export class MediaTruncatedError extends Error {
  constructor(key: string, emitted: number, expected: number) {
    super(
      `media ${key} ended after ${emitted} of ${expected} bytes; the row was ` +
        `deleted or became invisible mid-stream`,
    );
    this.name = "MediaTruncatedError";
  }
}

async function put(
  db: CompanyClient,
  companyId: string,
  input: MediaPut,
): Promise<{ key: string; deduped: boolean }> {
  /*
   * The id is generated here rather than by the default so that the upsert can
   * report whether it inserted: if the row that comes back is not the one this
   * call proposed, the bytes were already held.
   *
   * upsert and not create-catch-P2002, because a failed INSERT aborts the
   * surrounding transaction in Postgres - the caller is inside withCompany, so
   * catching the error and carrying on is not available. ON CONFLICT is one
   * statement and is safe against a concurrent writer.
   */
  const candidate = createId();

  const row = await db.whatsAppMedia.upsert({
    where: { companyId_sha256: { companyId, sha256: input.sha256 } },
    create: {
      id: candidate,
      companyId,
      sha256: input.sha256,
      mimeType: input.mimeType,
      fileName: input.fileName,
      byteSize: input.byteSize,
      state: input.bytes ? "STORED" : "SKIPPED",
      bytes: input.bytes ?? null,
      skippedReason: input.skippedReason ?? null,
    },
    /*
     * Empty on purpose. Holding the same file twice is not new information, and
     * rewriting the row would bump updated_at for nothing.
     *
     * Nothing needs naming here for scoping: the extension merges companyId
     * into `where`, and the RLS USING clause restricts which row an UPDATE can
     * reach regardless. That is worth stating because the extension does NOT
     * merge companyId into `update`, so an update arm with fields in it would
     * need to say so itself.
     */
    update: {},
    select: { id: true },
  });

  return { key: row.id, deduped: row.id !== candidate };
}

async function stat(
  db: CompanyClient,
  companyId: string,
  key: string,
): Promise<MediaStat | null> {
  const row = await db.whatsAppMedia.findUnique({
    where: { id: key },
    select: {
      id: true,
      sha256: true,
      mimeType: true,
      fileName: true,
      byteSize: true,
      state: true,
      skippedReason: true,
    },
  });

  if (!row) return null;

  return {
    key: row.id,
    sha256: row.sha256,
    mimeType: row.mimeType,
    fileName: row.fileName,
    byteSize: row.byteSize,
    state: row.state as MediaStateName,
    skippedReason: row.skippedReason,
  };
}

/**
 * One slice of the column, in its own short transaction.
 *
 * substring() on a bytea is a server-side slice only because the column is
 * STORAGE EXTERNAL: TOAST can fetch part of an uncompressed out-of-line value
 * without detoasting the whole thing. Under the default EXTENDED the value is
 * compressed and every slice decompresses from the start, which turns this loop
 * into N full reads while still looking like streaming.
 *
 * That setting is not expressible in schema.prisma and is invisible to
 * `migrate diff`, so what keeps it true is the OUT_OF_BAND_DDL sweep in
 * tests/schema-invariants.test.ts. If that entry is ever removed, this comment
 * is the reason to put it back.
 *
 * Postgres substring is 1-based; offset is not.
 */
async function readChunk(
  companyId: string,
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
  const rows = await withCompany(companyId, (db) =>
    db.$queryRaw<Array<{ chunk: Uint8Array | null }>>`
      SELECT substring(bytes from ${offset + 1} for ${length}) AS chunk
        FROM whatsapp_media
       WHERE id = ${key}`,
  );

  return rows[0]?.chunk ?? null;
}

async function get(
  companyId: string,
  key: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const meta = await withCompany(companyId, (db) => stat(db, companyId, key));

  if (!meta || meta.state !== "STORED") return null;

  const { byteSize } = meta;

  /*
   * The common case, kept out of the loop deliberately: a photo, a voice note
   * or a PDF quote is almost always under 512 KiB, so it is one read and one
   * pool checkout. Folding this back into the loop would cost a second query
   * per download to discover there is nothing left - which is the version
   * somebody will write while tidying up, so this comment is the argument
   * against it.
   */
  if (byteSize <= CHUNK_BYTES) {
    const only = await readChunk(companyId, key, 0, byteSize);

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
          key,
          offset,
          Math.min(CHUNK_BYTES, byteSize - offset),
        );

        /*
         * The row vanished, or stopped being visible, between chunks - a
         * delete, or a company deactivated mid-download.
         *
         * The response headers went out with the first chunk, so there is no
         * status code left to change: ending the stream quietly would hand the
         * client a truncated file under a 200 that already promised
         * Content-Length bytes. A browser saves that as a corrupt image with
         * no indication anything went wrong.
         *
         * Erroring destroys the stream instead, which breaks the transfer
         * visibly. A failed download the user can retry beats a silently
         * corrupt one they cannot detect.
         */
        if (!chunk || chunk.byteLength === 0) {
          controller.error(new MediaTruncatedError(key, offset, byteSize));
          return;
        }

        offset += chunk.byteLength;
        controller.enqueue(chunk);

        /* A short read is the same failure arriving one chunk earlier. */
        if (offset < byteSize && chunk.byteLength < CHUNK_BYTES) {
          controller.error(new MediaTruncatedError(key, offset, byteSize));
        }
      },
    },
    /*
     * highWaterMark 0: never read ahead.
     *
     * The default strategy pulls one chunk before the consumer asks for it,
     * which costs a 512 KiB buffer and a pool checkout for a chunk a client
     * that disconnects will never take. At zero, one read() is one chunk is
     * one short transaction, and nothing is fetched speculatively.
     *
     * It is also what makes the vanish detectable at the moment it happens
     * rather than one chunk late - with read-ahead, chunk N+1 has already been
     * fetched by the time the consumer sees chunk N, so a row deleted in
     * between is only noticed after the buffered chunk drains.
     */
    { highWaterMark: 0 },
  );
}

export const mediaStore: MediaStore = { put, stat, get };
