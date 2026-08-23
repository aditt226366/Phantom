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
    expect(target?.seenThrough.toISOString()).toBe(T2.toISOString());
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
  it("clears it when nothing has arrived since", async () => {
    await inbound("wamid.1", T0);
    await inbound("wamid.2", T1);

    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    const cleared = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.seenThrough),
    );

    expect(cleared).toBe(true);
    expect((await readConversation()).unreadCount).toBe(0);
  });

  it("keeps it when a message arrives between the receipt and the reset", async () => {
    await inbound("wamid.1", T0);

    /* What the reader saw when they opened it. */
    const target = await withCompany(alpha.id, (db, companyId) =>
      readReceiptTarget(db, companyId, conversationId),
    );

    /* The customer writes again while the receipt is in flight. */
    await inbound("wamid.2", T1);

    const cleared = await withCompany(alpha.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, target!.seenThrough),
    );

    /*
     * R1's second half. An assignment here would drop the new message's badge
     * silently: the thread would look read, nobody would be told, and the
     * customer would wait. The conditional matches no rows instead.
     */
    expect(cleared).toBe(false);
    expect((await readConversation()).unreadCount).toBe(2);
  });

  it("does not reach another company's thread", async () => {
    const beta = await seedCompany("beta");
    await inbound("wamid.1", T0);

    const cleared = await withCompany(beta.id, (db, companyId) =>
      markConversationRead(db, companyId, conversationId, T2),
    );

    expect(cleared).toBe(false);
    expect((await readConversation()).unreadCount).toBe(1);
  });
});
