import { decrypt, secretAad, type WhatsAppMarkReadJob } from "@whatsapp-os/core";
import { markWhatsAppRead } from "@whatsapp-os/core/whatsapp";
import { markConversationRead, readReceiptTarget, withCompany } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Tell Meta the customer's messages have been seen, and clear the badge.
 *
 * Read receipts are sent when a thread is opened - one of the five amendments
 * this phase carries. Two things keep that from becoming noise:
 *
 *   the enqueue site asks readReceiptTarget first, which answers null when
 *   nothing is unread, so re-opening a read thread enqueues nothing;
 *
 *   the job id names the conversation AND the newest inbound message, so three
 *   opens in a row collapse into one job rather than three POSTs.
 *
 * Read, call, write - the same shape as every other job here, and for the same
 * reason: a Graph call inside a company scope holds a pooled connection for as
 * long as Meta takes to answer.
 */

export type MarkReadResult = "marked" | "nothing_to_mark" | "badge_kept";

export async function handleWhatsAppMarkRead(
  payload: WhatsAppMarkReadJob,
): Promise<{ result: MarkReadResult }> {
  const { companyId, conversationId } = payload;

  /* 1. Read: what to mark, and the credentials to mark it with. */
  const loaded = await withCompany(companyId, async (db, scoped) => {
    const target = await readReceiptTarget(db, scoped, conversationId);
    if (!target) return null;

    const conversation = await db.conversation.findFirst({
      where: { id: conversationId },
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
    });

    return conversation ? { target, number: conversation.whatsappNumber } : null;
  });

  if (!loaded) {
    /*
     * Nothing unread, no inbound message, or the thread is gone. The ordinary
     * answer, and not worth a retry: people open read threads constantly, and
     * a job that reaches here has simply been overtaken.
     */
    return { result: "nothing_to_mark" };
  }

  const { target, number } = loaded;

  /* 2. Decrypt, then call. Nothing open. */
  const secrets: Record<string, string> = {};
  for (const row of number.integration.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, number.integrationId, row.key),
    );
  }

  const result = await markWhatsAppRead(secrets, target.wamid);

  if (!result.ok) {
    /*
     * Thrown, so BullMQ retries. Safe to repeat in a way most of this phase is
     * not: marking the same message read twice is not a second anything, which
     * is why this job keeps the default five attempts while the send job takes
     * exactly one.
     */
    throw new Error(
      `Could not mark ${target.wamid} read (${result.kind}): ${result.error}`,
    );
  }

  /* 3. Write: subtract exactly what the reader saw. */
  const remaining = await withCompany(companyId, (db, scoped) =>
    markConversationRead(db, scoped, conversationId, target.unreadCount),
  );

  log.info("thread marked read", {
    companyId,
    conversationId,
    wamid: target.wamid,
    seen: target.unreadCount,
    remaining,
  });

  /*
   * `badge_kept` is a success, not a failure. A non-zero remainder means
   * messages arrived while the receipt was in flight, and the decrement left
   * exactly those behind - which is the point, and worth seeing in the logs
   * rather than inferring from a badge somebody complains about.
   */
  return { result: remaining === 0 ? "marked" : "badge_kept" };
}
