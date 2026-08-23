import { beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERY_UNKNOWN_TITLE,
  recordSendAccepted,
  recordSendDeclined,
  recordSendRefused,
  recordSendUnconfirmed,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The four endings of an outbound message, written where the thread can see
 * them.
 *
 * Against a real database because the distinctions are all in stored state: a
 * status a claim-query must not pick up, an error namespace that must not be
 * confused with Meta's, and error columns that must not survive a retry that
 * succeeded.
 */

let alpha: SeededCompany;
let conversationId: string;

const OCCURRED = new Date("2026-08-16T12:00:00.000Z");

async function newMessage(): Promise<string> {
  return withCompany(alpha.id, async (db, companyId) => {
    const message = await db.message.create({
      data: {
        companyId,
        conversationId,
        direction: "OUTBOUND",
        type: "text",
        status: "PENDING",
        body: "hello",
        occurredAt: OCCURRED,
      },
    });
    return message.id;
  });
}

function readMessage(id: string) {
  return withCompany(alpha.id, (db) =>
    db.message.findFirstOrThrow({ where: { id } }),
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
        phoneNumberId: "pn-1",
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

describe("Meta accepted it", () => {
  it("stores the wamid and the status in one update", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendAccepted(db, companyId, id, {
        wamid: "wamid.1",
        held: false,
        waId: "wa-customer",
      }),
    );

    const row = await readMessage(id);
    /*
     * Both together is what keeps the status floor ours rather than the
     * webhook's: by the time any callback can match this wamid, the row already
     * says SENT. C7 leans on that.
     */
    expect(row.wamid).toBe("wamid.1");
    expect(row.status).toBe("SENT");
  });

  it("says HELD when Meta is holding it rather than sending", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendAccepted(db, companyId, id, {
        wamid: "wamid.1",
        held: true,
        waId: null,
      }),
    );

    /* Calling this SENT would put a bubble in the thread that will never
       progress and never fail. */
    expect((await readMessage(id)).status).toBe("HELD");
  });

  it("clears an error left by an earlier attempt", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendUnconfirmed(db, companyId, id),
    );

    await withCompany(alpha.id, (db, companyId) =>
      recordSendAccepted(db, companyId, id, {
        wamid: "wamid.1",
        held: false,
        waId: null,
      }),
    );

    /* A retry that went through must not keep the old warning beside a bubble
       that has now arrived. */
    const row = await readMessage(id);
    expect(row.status).toBe("SENT");
    expect(row.errorTitle).toBeNull();
    expect(row.errorSource).toBeNull();
  });
});

describe("Meta refused it", () => {
  it("stores Meta's own code and title, in Meta's namespace", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendRefused(db, companyId, id, {
        code: 131_047,
        title: "Re-engagement message outside the 24 hour window",
        occurredAt: OCCURRED,
      }),
    );

    const row = await readMessage(id);
    expect(row.status).toBe("FAILED");
    expect(row.errorSource).toBe("META");
    expect(row.errorCode).toBe(131_047);
    expect(row.errorTitle).toContain("24 hour window");
    expect(row.failedAt?.toISOString()).toBe(OCCURRED.toISOString());
  });
});

describe("we declined it before calling", () => {
  it("records the refusal as ours, with a sentence and no Meta code", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendDeclined(db, companyId, id, "window_closed", OCCURRED),
    );

    const row = await readMessage(id);
    expect(row.status).toBe("FAILED");
    /* POLICY keeps our reasons and Meta's in separate namespaces, so a support
       reply never quotes a Graph code Meta did not issue. */
    expect(row.errorSource).toBe("POLICY");
    expect(row.errorCode).toBeNull();
    expect(row.errorTitle).toContain("24-hour window closed");
  });
});

describe("Meta never answered", () => {
  it("is neither failed nor sent nor pending", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendUnconfirmed(db, companyId, id),
    );

    const row = await readMessage(id);

    /*
     * The distinction the whole status exists for. FAILED would claim knowledge
     * we do not have and invite a retry as if it were free; SENT would claim
     * the opposite; PENDING would be picked up by anything that claims work by
     * status and sent again.
     */
    expect(row.status).toBe("UNCONFIRMED");
    expect(row.wamid).toBeNull();
    expect(row.errorTitle).toBe(DELIVERY_UNKNOWN_TITLE);
    expect(row.errorTitle).toContain("Check WhatsApp before sending again");
  });

  it("carries no error source, because nobody refused it", async () => {
    const id = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendUnconfirmed(db, companyId, id),
    );

    /*
     * META would claim Meta refused it, which it did not - it said nothing -
     * and POLICY would claim we declined, which we also did not. A populated
     * title beside a null source is the shape that means "no verdict".
     */
    const row = await readMessage(id);
    expect(row.errorSource).toBeNull();
    expect(row.errorCode).toBeNull();
  });

  it("is not picked up by a query that claims pending work", async () => {
    const pending = await newMessage();
    const doubtful = await newMessage();

    await withCompany(alpha.id, (db, companyId) =>
      recordSendUnconfirmed(db, companyId, doubtful),
    );

    /*
     * The reason this is a status rather than PENDING plus a marker. The schema
     * says "the send worker claims rows by status", and anything doing that
     * would re-send an unconfirmed message - the exact duplicate attempts: 1
     * exists to prevent - unless every such query remembers an extra clause.
     */
    const claimed = await withCompany(alpha.id, (db) =>
      db.message.findMany({ where: { status: "PENDING" }, select: { id: true } }),
    );

    expect(claimed.map((row) => row.id)).toEqual([pending]);
  });
});
