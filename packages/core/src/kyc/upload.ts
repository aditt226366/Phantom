import { createHash } from "node:crypto";

/**
 * Reading an uploaded document, refusing it before it is resident.
 *
 * Server-only - node:crypto - so this is deliberately NOT in ./index.ts. That
 * barrel has to stay importable from a "use client" component, and the core
 * barrel dragging @node-rs/argon2 into the browser graph is a mistake this
 * repository has already made twice. Import from @whatsapp-os/core/kyc-server.
 *
 * ---------------------------------------------------------------------------
 * Both checks are made on the bytes, and both are made early
 * ---------------------------------------------------------------------------
 *
 * The size cap is enforced DURING the stream: the read is abandoned the moment
 * the running count crosses the limit. Not from Content-Length, which is the
 * client's word for it, and not after the read finishes, which means a 200 MB
 * body was already in the process before anyone looked. Refusing afterwards is
 * a memory exhaustion vector wearing a validation check.
 *
 * The file type comes from the first five bytes. Never the extension, never
 * the Content-Type the browser volunteered - both are supplied by whoever is
 * uploading, so neither is evidence of anything. A CHECK constraint repeats
 * both in the database, which is the backstop for a second upload path written
 * later by somebody who has not read this file.
 */

/** 5 MiB. The CHECK constraint in 20260831090000 holds the same number. */
export const MAX_KYC_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The first five bytes of every PDF ever written. */
const PDF_MAGIC = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * Why an upload was refused.
 *
 * A closed union of machine codes, for the reason SendRefusal and FeatureBlock
 * give: the sentence belongs where it is displayed, and prose here would be
 * matched on eventually.
 */
export type UploadRejection =
  /** Crossed the cap. Reported with no byte count - see below. */
  | "too_large"
  /** The bytes do not begin %PDF-, whatever the file was called. */
  | "not_a_pdf"
  /** Nothing arrived at all. A form submitted with no file selected. */
  | "empty"
  /** The stream failed part way. Not the uploader's fault, and retryable. */
  | "read_failed";

export type UploadOutcome =
  | {
      ok: true;
      bytes: Uint8Array<ArrayBuffer>;
      byteSize: number;
      sha256: string;
    }
  | { ok: false; reason: UploadRejection };

/**
 * Read an upload, or refuse it.
 *
 * The magic-byte check runs as soon as five bytes have arrived rather than at
 * the end, so a large non-PDF is refused after one chunk instead of after five
 * megabytes. That ordering is the difference between a validation check and a
 * way to make the server read anything an attacker sends.
 *
 * `too_large` carries no byte count, unlike the media path's equivalent. There
 * the number is rendered - "6.2 MB, not stored" beside a message - and here it
 * would only ever be a number we stopped counting at, since the read is
 * abandoned mid-stream. Reporting a total we deliberately did not measure
 * would be a small lie in a place where the reason has to be exact.
 */
export async function readPdfUpload(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_KYC_UPLOAD_BYTES,
): Promise<UploadOutcome> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let magicChecked = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      received += value.byteLength;

      if (received > maxBytes) {
        /* Stop the transfer rather than finish it and discard the result. */
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }

      chunks.push(value);

      /*
       * As early as possible, and only once.
       *
       * The header may straddle a chunk boundary - a client is free to send
       * the first byte on its own - so this waits for five bytes rather than
       * assuming the first chunk holds them. Checking `chunks[0]` alone would
       * work on every browser anyone tests with and fail on a slow uplink.
       */
      if (!magicChecked && received >= PDF_MAGIC.length) {
        magicChecked = true;

        if (!startsWithPdfMagic(chunks)) {
          await reader.cancel();
          return { ok: false, reason: "not_a_pdf" };
        }
      }
    }
  } catch {
    /*
     * The connection dropped part way. Deliberately not `not_a_pdf`: this is
     * not the uploader's fault and the remedy is to try again, which is the
     * opposite advice from "send a different file".
     */
    return { ok: false, reason: "read_failed" };
  }

  if (received === 0) return { ok: false, reason: "empty" };

  /*
   * Shorter than the magic number - so the loop never checked it. Five bytes
   * is not a PDF by any reading, and this is the arm that catches a one-byte
   * upload rather than letting it through to the CHECK constraint.
   */
  if (!magicChecked) return { ok: false, reason: "not_a_pdf" };

  const bytes = new Uint8Array(new ArrayBuffer(received));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    bytes,
    byteSize: received,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Do the first five bytes across these chunks spell %PDF-? */
function startsWithPdfMagic(chunks: Uint8Array[]): boolean {
  let matched = 0;

  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (byte !== PDF_MAGIC[matched]) return false;
      matched += 1;
      if (matched === PDF_MAGIC.length) return true;
    }
  }

  return false;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Identical treatment to the media route's, and for the identical reason: this
 * string came from whoever uploaded the file, so a newline in it splits the
 * response and a double quote closes the parameter early - after which the
 * rest of the name is read as header syntax.
 *
 * Stripped rather than percent-encoded, because the filename on a download is
 * a convenience and not worth an RFC 5987 dance. Truncated because a header a
 * server refuses to emit is a download that fails for a reason nobody can see.
 *
 * Returns null when nothing survives, and the caller then sends no filename at
 * all rather than an empty one - `filename=""` makes some browsers save the
 * file under the URL's last segment, which here is an opaque cuid.
 */
export function safeDocumentFilename(name: string | null): string | null {
  if (!name) return null;

  const cleaned = name
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 100);

  return cleaned.length > 0 ? cleaned : null;
}
