import { windowExpiryFor } from "@whatsapp-os/core/whatsapp";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceConversation,
  applyStatusUpdate,
  canSend,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The send path's preconditions, and the two updates that must never go
 * backwards.
 *
 * Not isolation tests. Every assertion here would still hold with the policies
 * dropped - what they prove is that the loader wires each fact to the field
 * sendPolicy reads, and that an out-of-order delivery cannot undo a newer one.
 * The cross-company halves live in rls-isolation.test.ts, in raw SQL, because
 * only raw SQL proves the boundary rather than the convention.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

/* A fixed instant. The window arithmetic is exact, so a moving clock would
   make the assertions approximate for no reason. */
const NOW = new Date("2026-08-15T12:00:00.000Z");
const AN_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);

interface Thread {
  contactId: string;
  numberId: string;
  conversationId: string;
}

async function seedThread(
  company: SeededCompany,
  label: string,
  numberStatus: "CONNECTED" | "UNKNOWN" | "FLAGGED" | "RESTRICTED" = "CONNECTED",
): Promise<Thread> {
  return withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: `${label}-pn`,
        displayNumber: "+91 98765 43210",
        status: numberStatus,
      },
    });
    const contact = await db.contact.create({
      data: { companyId, waId: `${label}-wa` },
    });
    const conversation = await db.conversation.create({
      data: {
        companyId,
        contactId: contact.id,
        whatsappNumberId: number.id,
        /* Open by default, and clear of the closing threshold - the boundary
           belongs to describeWindow's own tests, not to these. */
        windowExpiresAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000),
      },
    });

    return {
      contactId: contact.id,
      numberId: number.id,
      conversationId: conversation.id,
    };
  });
}

function readConversation(company: SeededCompany, conversationId: string) {
  return withCompany(company.id, (db) =>
    db.conversation.findFirstOrThrow({ where: { id: conversationId } }),
  );
}

async function seedMessage(
  company: SeededCompany,
  thread: Thread,
  wamid: string,
  status: "PENDING" | "HELD" | "SENT" | "DELIVERED" | "READ" | "FAILED",
): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    await db.message.create({
      data: {
        companyId,
        conversationId: thread.conversationId,
        direction: "OUTBOUND",
        type: "text",
        status,
        wamid,
        body: "hello",
        occurredAt: TWO_HOURS_AGO,
      },
    });
  });
}

function readMessage(company: SeededCompany, wamid: string) {
  return withCompany(company.id, (db) =>
    db.message.findFirstOrThrow({ where: { wamid } }),
  );
}

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

describe("canSend", () => {
  it("allows a free-form reply inside the window, and says what to send it through", async () => {
    const thread = await seedThread(alpha, "a");

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    expect(result?.decision).toEqual({ allowed: true });
    /* The target comes back with the verdict, so the worker needs no second
       read between deciding and calling Meta. */
    expect(result?.phoneNumberId).toBe("a-pn");
    expect(result?.waId).toBe("a-wa");
    expect(result?.window).toEqual({ kind: "open", hours: 3 });
  });

  it("refuses once the stored window has passed", async () => {
    const thread = await seedThread(alpha, "a");

    await withCompany(alpha.id, (db) =>
      db.conversation.update({
        where: { id: thread.conversationId },
        data: { windowExpiresAt: AN_HOUR_AGO },
      }),
    );

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    expect(result?.decision).toEqual({
      allowed: false,
      reason: "window_closed",
    });
  });

  it("refuses a number Meta has told us nothing about", async () => {
    const thread = await seedThread(alpha, "a", "UNKNOWN");

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    expect(result?.decision).toEqual({
      allowed: false,
      reason: "number_status_unknown",
    });
  });

  it("refuses an opted-out contact ahead of the window", async () => {
    const thread = await seedThread(alpha, "a");

    await withCompany(alpha.id, async (db) => {
      await db.contact.update({
        where: { id: thread.contactId },
        data: { optedOutAt: AN_HOUR_AGO },
      });
      await db.conversation.update({
        where: { id: thread.conversationId },
        data: { windowExpiresAt: AN_HOUR_AGO },
      });
    });

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    /*
     * Both refusals apply. Reporting the window would send somebody off to
     * write a template for a contact who has asked not to be messaged.
     */
    expect(result?.decision).toEqual({
      allowed: false,
      reason: "contact_opted_out",
    });
  });

  it("refuses a suspended workspace, which resolution deliberately does not", async () => {
    const thread = await seedThread(alpha, "a");

    await withCompany(alpha.id, (db) =>
      db.company.update({
        where: { id: alpha.id },
        data: { deactivatedAt: AN_HOUR_AGO },
      }),
    );

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    expect(result?.decision).toEqual({
      allowed: false,
      reason: "company_deactivated",
    });
  });

  it("refuses a template because there are none yet, window or no window", async () => {
    const thread = await seedThread(alpha, "a");

    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(
        db,
        companyId,
        thread.conversationId,
        { kind: "template", approved: true },
        NOW,
      ),
    );

    /* The one arm 4b flips. Until then an open window does not help. */
    expect(result?.decision).toEqual({
      allowed: false,
      reason: "template_not_available",
    });
  });

  it("returns null for another company's conversation, not a refusal", async () => {
    const thread = await seedThread(alpha, "a");

    const result = await withCompany(beta.id, (db, companyId) =>
      canSend(db, companyId, thread.conversationId, { kind: "freeform" }, NOW),
    );

    /* Rule 6. A refusal carrying a reason would confirm the id exists. */
    expect(result).toBeNull();
  });

  it("returns null for a conversation that does not exist at all", async () => {
    const result = await withCompany(alpha.id, (db, companyId) =>
      canSend(db, companyId, "cnv_nothing", { kind: "freeform" }, NOW),
    );

    expect(result).toBeNull();
  });
});

describe("advanceConversation", () => {
  it("opens the window on the first inbound message", async () => {
    const thread = await seedThread(alpha, "a");
    await withCompany(alpha.id, (db) =>
      db.conversation.update({
        where: { id: thread.conversationId },
        data: { windowExpiresAt: null, lastMessageAt: null, lastInboundAt: null },
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: AN_HOUR_AGO,
        preview: "first",
        inbound: true,
        windowExpiresAt: windowExpiryFor(AN_HOUR_AGO),
        unread: 1,
      }),
    );

    const row = await readConversation(alpha, thread.conversationId);

    /*
     * Exact instants, not approximate ones. These columns are timestamp(3)
     * without time zone and the statement binds UTC explicitly; a cast that
     * went through the session's TimeZone would land here as an offset, and a
     * tolerant assertion would let it through on any machine but the CI one.
     */
    expect(row.lastMessageAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
    expect(row.lastInboundAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
    expect(row.windowExpiresAt?.toISOString()).toBe(
      windowExpiryFor(AN_HOUR_AGO).toISOString(),
    );
    expect(row.lastMessagePreview).toBe("first");
    expect(row.unreadCount).toBe(1);
  });

  it("does not move the window backwards when Meta delivers out of order", async () => {
    const thread = await seedThread(alpha, "a");

    /* The newer message arrives first, which is the ordinary case for a burst. */
    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: AN_HOUR_AGO,
        preview: "newer",
        inbound: true,
        windowExpiresAt: windowExpiryFor(AN_HOUR_AGO),
        unread: 1,
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: TWO_HOURS_AGO,
        preview: "older",
        inbound: true,
        windowExpiresAt: windowExpiryFor(TWO_HOURS_AGO),
        unread: 1,
      }),
    );

    const row = await readConversation(alpha, thread.conversationId);

    /* R1. Assignment here closes the composer while the window is open. */
    expect(row.windowExpiresAt?.toISOString()).toBe(
      windowExpiryFor(AN_HOUR_AGO).toISOString(),
    );
    expect(row.lastMessageAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
    expect(row.lastInboundAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());

    /* The preview follows the newest message, not the last write. */
    expect(row.lastMessagePreview).toBe("newer");

    /* But both messages are unread. A count is a count, whatever the order. */
    expect(row.unreadCount).toBe(2);
  });

  it("advances everything when the newer message arrives second", async () => {
    const thread = await seedThread(alpha, "a");

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: TWO_HOURS_AGO,
        preview: "older",
        inbound: true,
        windowExpiresAt: windowExpiryFor(TWO_HOURS_AGO),
        unread: 1,
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: AN_HOUR_AGO,
        preview: "newer",
        inbound: true,
        windowExpiresAt: windowExpiryFor(AN_HOUR_AGO),
        unread: 1,
      }),
    );

    const row = await readConversation(alpha, thread.conversationId);

    expect(row.windowExpiresAt?.toISOString()).toBe(
      windowExpiryFor(AN_HOUR_AGO).toISOString(),
    );
    expect(row.lastMessagePreview).toBe("newer");
    expect(row.unreadCount).toBe(2);
  });

  it("leaves the window alone when we are the ones sending", async () => {
    const thread = await seedThread(alpha, "a");

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: TWO_HOURS_AGO,
        preview: "customer",
        inbound: true,
        windowExpiresAt: windowExpiryFor(TWO_HOURS_AGO),
        unread: 1,
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      advanceConversation(db, companyId, thread.conversationId, {
        occurredAt: AN_HOUR_AGO,
        preview: "our reply",
        inbound: false,
        windowExpiresAt: null,
        unread: 0,
      }),
    );

    const row = await readConversation(alpha, thread.conversationId);

    /*
     * Replying does not extend the window and does not count as the customer
     * writing - null must leave the stored value alone rather than erase it,
     * which is the property GREATEST's NULL handling is relied on for.
     */
    expect(row.windowExpiresAt?.toISOString()).toBe(
      windowExpiryFor(TWO_HOURS_AGO).toISOString(),
    );
    expect(row.lastInboundAt?.toISOString()).toBe(TWO_HOURS_AGO.toISOString());

    /* The thread still moved, and the inbox still sorts by it. */
    expect(row.lastMessageAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
    expect(row.lastMessagePreview).toBe("our reply");
    expect(row.unreadCount).toBe(1);
  });
});

describe("applyStatusUpdate", () => {
  it("advances a sent message to delivered, and stamps when", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "SENT");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "delivered",
        occurredAt: AN_HOUR_AGO,
      }),
    );

    expect(outcome).toBe("advanced");

    const row = await readMessage(alpha, "wamid.1");
    expect(row.status).toBe("DELIVERED");
    expect(row.deliveredAt?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
    expect(row.readAt).toBeNull();
  });

  it("refuses to walk backwards when a stale sent arrives after a read", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "READ");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "sent",
        occurredAt: NOW,
      }),
    );

    /*
     * The guard is inside the UPDATE, so this is zero rows rather than a
     * comparison somebody could lose a race to.
     */
    expect(outcome).toBe("stale");
    expect((await readMessage(alpha, "wamid.1")).status).toBe("READ");
  });

  it("treats a redelivery of the same status as a no-op", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "DELIVERED");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "delivered",
        occurredAt: NOW,
      }),
    );

    /* Meta redelivers. statusesBelow is strict, so this matches no row. */
    expect(outcome).toBe("stale");
  });

  it("lets a sent callback release a message Meta was holding", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "HELD");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "sent",
        occurredAt: NOW,
      }),
    );

    /*
     * The whole reason HELD ranks below SENT. Ranked above it, this callback
     * would be discarded and the thread would read "held" for ever while the
     * customer was already replying.
     */
    expect(outcome).toBe("advanced");
    expect((await readMessage(alpha, "wamid.1")).status).toBe("SENT");
  });

  it("records a failure in Meta's namespace, not ours", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "SENT");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "failed",
        occurredAt: NOW,
        error: { code: 131_026, title: "Message undeliverable" },
      }),
    );

    expect(outcome).toBe("advanced");

    const row = await readMessage(alpha, "wamid.1");
    expect(row.status).toBe("FAILED");
    expect(row.failedAt?.toISOString()).toBe(NOW.toISOString());
    /* POLICY is ours. A support reply must never quote a code Meta did not
       issue. */
    expect(row.errorSource).toBe("META");
    expect(row.errorCode).toBe(131_026);
    expect(row.errorTitle).toBe("Message undeliverable");
  });

  it("leaves a message alone when Meta sends a status this build cannot rank", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "SENT");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "warehoused",
        occurredAt: NOW,
      }),
    );

    /*
     * Not an error. Meta has shipped new status strings before, and the raw
     * value survives in whatsapp_webhook_events.payload either way.
     */
    expect(outcome).toBe("unknown_status");
    expect((await readMessage(alpha, "wamid.1")).status).toBe("SENT");
  });

  it("separates a status for a message we do not have from a stale one", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "SENT");

    const outcome = await withCompany(alpha.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.absent",
        status: "delivered",
        occurredAt: NOW,
      }),
    );

    /*
     * Worth its extra read: a status for a wamid we never stored means a
     * message sent from Business Manager, or a row that went missing, and the
     * webhook worker records it rather than counting it as routine.
     */
    expect(outcome).toBe("no_such_message");
  });

  it("does not reach a message in another company", async () => {
    const thread = await seedThread(alpha, "a");
    await seedMessage(alpha, thread, "wamid.1", "SENT");

    const outcome = await withCompany(beta.id, (db, companyId) =>
      applyStatusUpdate(db, companyId, {
        wamid: "wamid.1",
        status: "delivered",
        occurredAt: NOW,
      }),
    );

    /* Indistinguishable from a wamid that does not exist, which is the point. */
    expect(outcome).toBe("no_such_message");
    expect((await readMessage(alpha, "wamid.1")).status).toBe("SENT");
  });
});
