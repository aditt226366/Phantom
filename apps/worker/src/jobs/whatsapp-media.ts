import { createHash } from "node:crypto";
import { decrypt, secretAad, type WhatsAppMediaFetchJob } from "@whatsapp-os/core";
import {
  MAX_MEDIA_BYTES,
  downloadWhatsAppMedia,
  fetchWhatsAppMediaMetadata,
} from "@whatsapp-os/core/whatsapp";
import { mediaStore, withCompany } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Fetch an inbound media message's bytes before Meta's link expires.
 *
 * Meta's download URLs live for minutes, so this is not an optimisation that
 * can be deferred to the first person who opens the thread - by then the link
 * is dead and the file is unreachable. The webhook records the message and
 * enqueues this; this is the only thing that ever holds the bytes.
 *
 * Same three-step shape as every other job that talks to a provider:
 *
 *   1. read           one short transaction, which then closes
 *   2. call Meta      nothing open, network involved
 *   3. write          a second short transaction
 *
 * A Graph call inside a transaction holds a pooled connection for as long as
 * Meta takes to answer, and Prisma abandons it after five seconds. A media
 * download is the longest call in this system, so the split matters more here
 * than anywhere else.
 */

export type MediaFetchResult =
  | "stored"
  | "deduped"
  | "too_large"
  | "already_stored"
  | "unknown_message";

export async function handleWhatsAppMediaFetch(
  payload: WhatsAppMediaFetchJob,
): Promise<{ result: MediaFetchResult; byteSize?: number }> {
  const { companyId, messageId, metaMediaId } = payload;

  /* 1. Read: the message, and the credentials of the number it arrived on. */
  const message = await withCompany(companyId, (db) =>
    db.message.findFirst({
      where: { id: messageId },
      select: {
        id: true,
        mediaId: true,
        conversation: {
          select: {
            whatsappNumber: {
              select: {
                integrationId: true,
                integration: {
                  select: { secrets: { select: { key: true, ciphertext: true } } },
                },
              },
            },
          },
        },
      },
    }),
  );

  if (!message) {
    /*
     * Deleted, or never ours. Not an error and not worth a retry - the job
     * outlived its row, which is ordinary once retention starts deleting.
     */
    log.info("media fetch skipped: no such message", { companyId, messageId });
    return { result: "unknown_message" };
  }

  if (message.mediaId) {
    /*
     * Already linked. The webhook re-offers a download whenever bytes are
     * missing, and a job id keeps the two paths collapsed - but BullMQ only
     * remembers completed ids for an hour, so an exact repeat is expected
     * rather than impossible.
     */
    return { result: "already_stored" };
  }

  const number = message.conversation.whatsappNumber;

  /* 2. Decrypt, then call. No transaction is open from here to step 3. */
  const secrets: Record<string, string> = {};
  for (const row of number.integration.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, number.integrationId, row.key),
    );
  }

  const metadata = await fetchWhatsAppMediaMetadata(secrets, metaMediaId);

  if (!metadata.ok) {
    /*
     * Thrown rather than recorded, so BullMQ retries and a permanent failure
     * ends up in the failed queue where somebody reads it. There is no useful
     * middle state to store: a message with no bytes already renders as
     * unavailable, and inventing a media row to say so would put a file in the
     * table that never existed.
     */
    throw new Error(
      `Could not read media ${metaMediaId} (${metadata.kind}): ${metadata.error}`,
    );
  }

  const { sha256, mimeType, fileSize, url } = metadata.metadata;

  /*
   * The dedupe check, and the reason the metadata call is worth its round trip.
   * The same photo forwarded to fifty contacts is fifty media ids and one
   * hash - so forty-nine of those downloads never happen, and the fiftieth
   * message points at bytes that are already here.
   */
  const existing = await withCompany(companyId, (db) =>
    db.whatsAppMedia.findFirst({ where: { sha256 }, select: { id: true } }),
  );

  if (existing) {
    await link(companyId, messageId, existing.id);
    log.info("media deduped", { companyId, messageId, sha256 });
    return { result: "deduped" };
  }

  /*
   * Refused on Meta's own count, before transferring anything. The row is
   * still written: the thread says "6.2 MB, not stored" rather than showing a
   * message with nothing in it, and nothing retries a file that is simply too
   * big. downloadWhatsAppMedia enforces the same cap as the bytes arrive,
   * because file_size is a claim and this is the check that does not trust it.
   */
  if (fileSize > MAX_MEDIA_BYTES) {
    const key = await store(companyId, {
      sha256,
      mimeType,
      fileName: null,
      byteSize: fileSize,
      skippedReason: "over_max_size",
    });
    await link(companyId, messageId, key);

    log.info("media too large to store", { companyId, messageId, fileSize });
    return { result: "too_large", byteSize: fileSize };
  }

  const download = await downloadWhatsAppMedia(secrets, url);

  if (!download.ok && download.kind === "too_large") {
    /* file_size lied, or was absent. Same outcome, decided on real bytes. */
    const key = await store(companyId, {
      sha256,
      mimeType,
      fileName: null,
      byteSize: download.byteSize,
      skippedReason: "over_max_size",
    });
    await link(companyId, messageId, key);

    log.info("media exceeded the cap mid-download", {
      companyId,
      messageId,
      claimed: fileSize,
    });
    return { result: "too_large", byteSize: download.byteSize };
  }

  if (!download.ok) {
    throw new Error(
      `Could not download media ${metaMediaId} (${download.kind}): ${download.error}`,
    );
  }

  /*
   * Verify the bytes are the ones Meta described, before they are stored under
   * Meta's hash as their identity.
   *
   * The media table deduplicates on (company_id, sha256), so an unverified
   * digest is not a hygiene question but a correctness one: bytes stored under the
   * wrong hash would be handed back for a different file's key for as long as
   * the row exists. Cheap to check - the file is 5 MiB at most and already in
   * memory - and a mismatch throws, because a retry is exactly the right
   * response to a corrupted transfer.
   */
  const digest = createHash("sha256").update(download.bytes).digest("hex");

  if (digest !== sha256) {
    throw new Error(
      `Media ${metaMediaId} did not match the hash Meta gave for it ` +
        `(expected ${sha256}, got ${digest}). The transfer was corrupted.`,
    );
  }

  /* 3. Write. */
  const key = await store(companyId, {
    sha256,
    mimeType,
    fileName: null,
    byteSize: download.byteSize,
    bytes: download.bytes,
  });
  await link(companyId, messageId, key);

  log.info("media stored", {
    companyId,
    messageId,
    sha256,
    byteSize: download.byteSize,
  });

  return { result: "stored", byteSize: download.byteSize };
}

async function store(
  companyId: string,
  input: Parameters<typeof mediaStore.put>[2],
): Promise<string> {
  const { key } = await withCompany(companyId, (db, scoped) =>
    mediaStore.put(db, scoped, input),
  );

  return key;
}

/**
 * Point the message at the stored file.
 *
 * A separate statement from the put, and deliberately after it: a message
 * linked to a media row that does not exist yet is a broken thread, while a
 * media row nothing points at is invisible and harmless.
 */
async function link(
  companyId: string,
  messageId: string,
  mediaId: string,
): Promise<void> {
  await withCompany(companyId, (db) =>
    db.message.update({ where: { id: messageId }, data: { mediaId } }),
  );
}
