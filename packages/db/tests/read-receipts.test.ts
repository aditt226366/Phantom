import { markReadJobId } from "@whatsapp-os/core";
import { beforeEach, describe, expect, it } from "vitest";
import { markConversationRead, readReceiptTarget, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Opening a thread: what it tells Meta, and what it does to the badge.
 *
 * Both rules here are about a race, so both are asserted against a real
 * database: the reset is a conditional UPDATE whose whole value is the rows it
 * declines to touch, and a mock would report whatever the code asked for.
 */

let alpha: SeededCompany;
let conversationId: string;

const T0 = new Date("2026-08-15T10:00:00.000Z");
const T1 = new Date("2026-08-15T11:00:00.000Z");
const T2 = new Date("2026-08-15T12:00:00.000Z");

async function inbound(wamid: string, occurredAt: Date): Promise<string> {
  return withCompany(alpha.id, async (db, companyId) => {
    const message = await db.message.create({
      data: {
        companyId,
        conversationId,
        direction: "INBOUND",
        type: "text",
        status: "DELIVERED",
        wamid,
        body: wamid,
        occurredAt,
      },
    });

    await db.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: occurredAt,
        lastInboundAt: occurredAt,
        unreadCount: { increment: 1 },
      },
    });

    return message.id;
  });
}

function readConversation() {
  return withCompany(alpha.id, (db) =>
    db.conversation.findFirstOrThrow({ where: { id: conversationId } }),
  );
}

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");

  conversationId = await withCompany(alpha.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "pn-alpha",
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
    });
    const contact = await db.contact.create({
      data: { companyId, waId: "wa-customer" },
    });
    const conversation = await db.conversation.create({
      data: { companyId, contactId: contact.id, whatsappNumberId: number.id },
    });
    return conversation.id;
  });
});

describe("what opening a thread should tell Meta", () => {
  it("names only the newest inbound message", async () => {
    await inbound("wamid.1", T0);
    await inbound("wamid.2", T1);
    const newest = await inbound("wamid.3", T2);

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /*
     * Meta marks every earlier message read along with the one named, so three
     * unread messages are one call rather than three.
     */
    expect(target?.wamid).toBe("wamid.3");
    expect(target?.messageId).toBe(newest);
    /* And how many the reader saw, which is what the badge is decremented by. */
    expect(target?.unreadCount).toBe(3);
  });

  it("says nothing at all when the thread is already read", async () => {
    await inbound("wamid.1", T0);

    await withCompany(alpha.id, (db) =>
      db.conversation.update({
        where: { id: conversationId },
        data: { unreadCount: 0 },
      }),
    );

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /*
     * The rule that stops the steady-state noise. People re-open threads
     * constantly, and an already-read thread must enqueue nothing rather than
     * enqueue a job that discovers there is nothing to do.
     */
    expect(target).toBeNull();
  });

  it("says nothing for a thread the customer has never written in", async () => {
    await withCompany(alpha.id, async (db, companyId) => {
      await db.message.create({
        data: {
          companyId,
          conversationId,
          direction: "OUTBOUND",
          type: "text",
          status: "SENT",
          wamid: "wamid.out",
          occurredAt: T0,
        },
      });
      await db.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: T0, unreadCount: 1 },
      });
    });

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /* Nothing inbound to mark, whatever the badge says. */
    expect(target).toBeNull();
  });

  it("dedupes on the thread and the message together", () => {
    /*
     * Keyed on the conversation alone, a genuinely new message arriving after
     * the first open would collapse into the earlier job and never be marked
     * read at all.
     */
    expect(markReadJobId("cnv-1", "msg-1")).toBe("read:cnv-1:msg-1");
    expect(markReadJobId("cnv-1", "msg-2")).not.toBe(markReadJobId("cnv-1", "msg-1"));
  });
});

describe("clearing the badge", () => {
  it("clears it exactly when nothing has arrived since", async () => {
    await inbound("wamid.1", T0);
    await inbound("wamid.2", T1);

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    const remaining = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.unreadCount),
    );

    expect(remaining).toBe(0);
    expect((await readConversation()).unreadCount).toBe(0);
  });

  it("leaves behind whatever arrived while the receipt was in flight", async () => {
    await inbound("wamid.1", T0);

    /* What the reader saw when they opened it. */
    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /* The customer writes twice more before the reset lands. */
    await inbound("wamid.2", T1);
    await inbound("wamid.3", T2);

    const remaining = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.unreadCount),
    );

    /*
     * R1's second half. Assigning zero would drop both badges silently: the
     * thread would look read, nobody would be told, and the customer would
     * wait. Subtracting the one that was seen leaves exactly the two that
     * were not.
     */
    expect(remaining).toBe(2);
    expect((await readConversation()).unreadCount).toBe(2);
  });

  it("leaves behind a message delivered out of order, which a timestamp cannot", async () => {
    await inbound("wamid.2", T1);

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /*
     * Meta redelivers late. This message is OLDER than the one already seen, so
     * last_message_at does not move - it advances with GREATEST - while the
     * unread count does. A `WHERE last_message_at <= seen` guard would pass and
     * clear a badge nobody saw; the decrement does not care about order.
     */
    await withCompany(alpha.id, async (db, companyId) => {
      await db.message.create({
        data: {
          companyId,
          conversationId,
          direction: "INBOUND",
          type: "text",
          status: "DELIVERED",
          wamid: "wamid.late",
          occurredAt: T0,
        },
      });
      await db.conversation.update({
        where: { id: conversationId },
        data: { unreadCount: { increment: 1 } },
      });
    });

    const before = await readConversation();
    expect(before.lastMessageAt?.toISOString(), "the late message moved the clock").toBe(
      T1.toISOString(),
    );

    const remaining = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.unreadCount),
    );

    expect(remaining).toBe(1);
    expect((await readConversation()).unreadCount).toBe(1);
  });

  it("does not go negative if the same receipt is applied twice", async () => {
    await inbound("wamid.1", T0);
    await inbound("wamid.2", T1);

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.unreadCount),
    );

    /*
     * A job that failed after the reset applied, then retried. Normally
     * readReceiptTarget returns null at zero and it never gets here - the clamp
     * is what makes that "normally" not load-bearing, because a negative badge
     * is a rendering bug that outlives its cause.
     */
    const remaining = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.unreadCount),
    );

    expect(remaining).toBe(0);
    expect((await readConversation()).unreadCount).toBe(0);
  });

  it("does not reach another company's thread", async () => {
    const beta = await seedCompany("beta");
    await inbound("wamid.1", T0);

    const remaining = await withCompany(beta.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, 1),
    );

    expect(remaining).toBe(0);
    expect((await readConversation()).unreadCount).toBe(1);
  });
});
