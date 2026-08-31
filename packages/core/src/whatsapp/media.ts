import { graphGetJson } from "../providers/meta.ts";
import { PROVIDER_TIMEOUT_MS, type FailureKind, type FetchImpl } from "../providers/types.ts";
import { scrubText } from "../redact.ts";
import { MAX_MEDIA_BYTES } from "./graph.ts";

/**
 * Getting the bytes of an inbound media message.
 *
 * Two calls, and they are not interchangeable:
 *
 *   GET /{media-id}   metadata, including a download URL that expires
 *   GET <that url>    the bytes, from a lookaside host, still needing the token
 *
 * The URL is short-lived - minutes - which is the whole reason media is stored
 * rather than referenced. By the time somebody opens the thread tomorrow the
 * link is dead, so a message that only kept the URL shows a broken image and
 * there is no way back to the file.
 */

/** What GET /{media-id} answers. */
export interface WhatsAppMediaMetadata {
  id: string;
  /** Meta's hash of the content, and our identity for it. */
  sha256: string;
  mimeType: string;
  /** Meta's own count, before anything is transferred. */
  fileSize: number;
  /** Expires in minutes, and needs the access token even so. */
  url: string;
}

export type MediaMetadataOutcome =
  | { ok: true; metadata: WhatsAppMediaMetadata }
  | { ok: false; kind: FailureKind; error: string };

export type MediaDownloadOutcome =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; byteSize: number }
  /**
   * Bigger than we store. Not a failure: the row is recorded with its size and
   * no bytes, and the thread says so. Nothing retries it.
   */
  | { ok: false; kind: "too_large"; byteSize: number }
  | { ok: false; kind: FailureKind; error: string };

interface MediaResponse {
  id?: string;
  url?: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number | string;
}

/**
 * Ask Meta about a media id.
 *
 * Worth one round trip before any transfer, because the answer carries the
 * sha256 and the size. A file we already hold is then a metadata call and no
 * download at all, and a file over the cap is refused without moving 40 MB
 * across the network to discover its length.
 */
export async function fetchWhatsAppMediaMetadata(
  secrets: Readonly<Record<string, string>>,
  mediaId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<MediaMetadataOutcome> {
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!accessToken) {
    return { ok: false, kind: "config", error: "Access token is required." };
  }

  const result = await graphGetJson<MediaResponse>(
    mediaId,
    null,
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  if (!result.ok) {
    return { ok: false, kind: result.kind, error: result.error };
  }

  const { url, sha256, mime_type: mimeType } = result.data;
  const fileSize = Number(result.data.file_size ?? Number.NaN);

  /*
   * Every field is checked rather than trusted, and the reason is what happens
   * downstream: sha256 is the identity the media table deduplicates on, so a
   * missing one would either collide under an empty string or store the same
   * file repeatedly.
   */
  if (!url || !sha256 || !mimeType || !Number.isFinite(fileSize)) {
    /*
     * `transient` rather than `config`, and the distinction is not academic:
     * config means OUR credentials are wrong and demotes the integration's
     * badge, which would be a lie about a token that just worked. A malformed
     * answer is Meta's, retrying costs one call, and the alternative would put
     * a tenant's connection into NOT_CONNECTED over a missing field.
     */
    return {
      ok: false,
      kind: "transient",
      error: "Meta's media metadata was missing a url, sha256, mime type or size.",
    };
  }

  return {
    ok: true,
    metadata: { id: result.data.id ?? mediaId, sha256, mimeType, fileSize, url },
  };
}

/**
 * Download the bytes, refusing to hold more than the cap.
 *
 * ---------------------------------------------------------------------------
 * The limit is enforced as the bytes arrive, not from a header
 * ---------------------------------------------------------------------------
 *
 * content-length is a claim by the sender. A response that omits it, or states
 * one size and streams another, would sail past a header check and be buffered
 * in full - and this runs in a worker with several jobs in flight, so "one
 * oversized file" is really "as many as the concurrency allows", each held in
 * memory at once.
 *
 * So the running total is checked per chunk and the body is abandoned the
 * moment it crosses. The reader is cancelled explicitly, which tells the socket
 * to stop rather than politely reading 40 MB into a variable nobody keeps.
 */
export async function downloadWhatsAppMedia(
  secrets: Readonly<Record<string, string>>,
  url: string,
  fetchImpl: FetchImpl = fetch,
): Promise<MediaDownloadOutcome> {
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!accessToken) {
    return { ok: false, kind: "config", error: "Access token is required." };
  }

  try {
    const response = await fetchImpl(url, {
      /*
       * The lookaside URL is not public. It carries its own signature and
       * still requires the bearer token, so a download is as sensitive as any
       * other Graph call and the token goes in a header for the same reason.
       */
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      /*
       * 401 and 403 are the token; everything else is transient, including the
       * 404 an expired URL gives.
       *
       * That looks generous for a 404 and is deliberate. The URL is only
       * reachable through a fresh metadata call, and a retry of this job starts
       * there - so "the link expired" is precisely the case a retry fixes,
       * which is what transient means here.
       */
      return {
        ok: false,
        kind: response.status === 401 || response.status === 403 ? "auth" : "transient",
        error: `Media download failed with HTTP ${response.status}.`,
      };
    }

    const body = response.body;

    if (!body) {
      return { ok: false, kind: "transient", error: "Media response had no body." };
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;

      if (received > MAX_MEDIA_BYTES) {
        /* Stop the transfer rather than finish it and discard the result. */
        await reader.cancel();
        return { ok: false, kind: "too_large", byteSize: received };
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(new ArrayBuffer(received));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { ok: true, bytes, byteSize: received };
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `Timed out after ${PROVIDER_TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);

    return {
      ok: false,
      kind: "transient",
      error: scrubText(message, Object.values(secrets)),
    };
  }
}
