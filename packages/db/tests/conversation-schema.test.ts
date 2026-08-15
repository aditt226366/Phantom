import { beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Constraints, not policies.
 *
 * These assert what the schema guarantees about identity and concurrency:
 * a wamid is claimed once per company, and there is one thread per contact per
 * number. Both would hold with row-level security switched off, which is
 * exactly why they are not in rls-isolation.test.ts - every test in that file
 * must fail when the policies are dropped, or the destructive audit stops
 * meaning anything and a sixth survivor is indistinguishable from a real hole.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

interface Thread {
  contactId: string;
  numberId: string;
  conversationId: string;
}

async function seedThread(company: SeededCompany, label: string): Promise<Thread> {
  const integrationId = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    return integration.id;
  });

  return withCompany(company.id, async (db, companyId) => {
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId,
        phoneNumberId: `${label}-pn`,
        displayNumber: "+91 98765 43210",
      },
    });
    const contact = await db.contact.create({
      data: { companyId, waId: `${label}-wa` },
    });
    const conversation = await db.conversation.create({
      data: { companyId, contactId: contact.id, whatsappNumberId: number.id },
    });

    return {
      contactId: contact.id,
      numberId: number.id,
      conversationId: conversation.id,
    };
  });
}

async function addMessage(
  company: SeededCompany,
  thread: Thread,
  wamid: string,
): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    await db.message.create({
      data: {
        companyId,
        conversationId: thread.conversationId,
        direction: "INBOUND",
        type: "text",
        status: "DELIVERED",
        wamid,
        occurredAt: new Date(),
      },
    });
  });
}

describe("message identity", () => {
  it("claims a wamid once per company", async () => {
    /*
     * Decision 7. Meta redelivers the same message, and a redelivery must not
     * appear twice in the thread.
     */
    const thread = await seedThread(alpha, "alpha");
    await addMessage(alpha, thread, "wamid-1");

    await expect(addMessage(alpha, thread, "wamid-1")).rejects.toThrow(/unique/i);
  });

  it("lets two companies hold the same wamid", async () => {
    /*
     * Why the unique is (company_id, wamid) and not wamid alone. Meta's ids are
     * unique in practice, but one tenant's traffic must never be able to make
     * another tenant's insert fail - that is a cross-company side effect, and
     * it would be one a customer could trigger deliberately.
     */
    const alphaThread = await seedThread(alpha, "alpha");
    const betaThread = await seedThread(beta, "beta");

    await addMessage(alpha, alphaThread, "shared-wamid");

    await expect(
      addMessage(beta, betaThread, "shared-wamid"),
    ).resolves.toBeUndefined();
  });

  it("lets many outbound messages sit pending at once", async () => {
    /*
     * The unique tolerates a null wamid because Postgres treats nulls as
     * distinct. An outbound message has no wamid until Meta answers, so a
     * stricter unique would let exactly one send be in flight per company.
     */
    const thread = await seedThread(alpha, "alpha");

    await withCompany(alpha.id, async (db, companyId) => {
      for (const id of ["p1", "p2", "p3"]) {
        await db.message.create({
          data: {
            id,
            companyId,
            conversationId: thread.conversationId,
            direction: "OUTBOUND",
            type: "text",
            occurredAt: new Date(),
          },
        });
      }
    });

    const pending = await withCompany(alpha.id, (db) =>
      db.message.count({ where: { status: "PENDING", wamid: null } }),
    );

    expect(pending).toBe(3);
  });
});

describe("one thread per contact per number", () => {
  it("refuses a second conversation for the same pair", async () => {
    /*
     * The conflict target the inbound upsert needs. Without it two webhook
     * deliveries for the same contact arriving together both find no
     * conversation and both insert, and the customer ends up with two
     * half-threads whose 24-hour windows disagree.
     */
    const thread = await seedThread(alpha, "alpha");

    await expect(
      withCompany(alpha.id, async (db, companyId) => {
        await db.conversation.create({
          data: {
            companyId,
            contactId: thread.contactId,
            whatsappNumberId: thread.numberId,
          },
        });
      }),
    ).rejects.toThrow(/unique/i);
  });

  it("makes the racing upsert converge on one row", async () => {
    /*
     * The property the unique exists for, exercised the way the webhook worker
     * will hit it: two upserts for the same pair, started together. One wins,
     * the other conflicts and updates, and exactly one conversation exists.
     *
     * companyId is named explicitly in the update arm. The withCompany
     * extension merges it into `where` and `create` but not `update`, so a
     * scoped upsert that omits it there is relying on something the extension
     * does not do.
     */
    const thread = await seedThread(alpha, "alpha");

    const upsert = () =>
      withCompany(alpha.id, (db, companyId) =>
        db.conversation.upsert({
          where: {
            companyId_contactId_whatsappNumberId: {
              companyId,
              contactId: thread.contactId,
              whatsappNumberId: thread.numberId,
            },
          },
          create: {
            companyId,
            contactId: thread.contactId,
            whatsappNumberId: thread.numberId,
          },
          update: { companyId, unreadCount: { increment: 1 } },
        }),
      );

    const results = await Promise.allSettled([upsert(), upsert()]);

    /* One may lose the race and throw; what must not happen is two rows. */
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const count = await withCompany(alpha.id, (db) =>
      db.conversation.count({
        where: {
          contactId: thread.contactId,
          whatsappNumberId: thread.numberId,
        },
      }),
    );

    expect(count).toBe(1);
  });
});
