import { beforeEach, describe, expect, it } from "vitest";

import {
  DASHBOARD_LIST_LIMIT,
  closingWindows,
  numberHealth,
  pendingTemplates,
  recentThreads,
  waitingForAHuman,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Every dashboard list has a total order, and therefore an answer.
 *
 * ---------------------------------------------------------------------------
 * What went wrong, and why nothing caught it for four phases
 * ---------------------------------------------------------------------------
 *
 * All five readers here sorted on a column that is not unique: created_at,
 * last_message_at, window_expires_at. `ORDER BY` on a tied key does not
 * constrain anything - Postgres returns tied rows in whatever order the plan
 * yields, and it is free to yield a different one tomorrow for the same rows.
 *
 * That is not a theoretical tie. Meta's refresh job inserts every number of an
 * account in one pass, so they tie to the microsecond. A broadcast advances
 * every recipient's conversation to the same `occurredAt`. The screenshot
 * fixture has thirteen conversations sharing a last_message_at, and three
 * numbers sharing a created_at - and the numbers card was photographed in one
 * order, then came back reversed on a later run with no edit to any query.
 * That is what surfaced this: a suite at maxDiffPixelRatio 0, failing on a
 * commit that touched neither the dashboard nor the fixture.
 *
 * ---------------------------------------------------------------------------
 * The reordering is the mild half
 * ---------------------------------------------------------------------------
 *
 * Four of the five take DASHBOARD_LIST_LIMIT. A LIMIT over a tied sort key
 * does not merely reorder the answer - it CHANGES it. Rows tied at the
 * boundary are interchangeable, so the database picks six of the eight and no
 * two runs need agree on which six.
 *
 * Nothing about that looks wrong on screen. The card renders six threads, the
 * count beside it is computed separately and stays right, and the two threads
 * that vanished are the ones nobody is looking at because they are not on the
 * dashboard. An operator working the "needs attention" queue would simply
 * never be shown them.
 *
 * So the assertions below are about ties specifically: every sort key equal,
 * and the answer still exactly one thing. The ids are deliberately assigned
 * against insertion order, so a plan returning rows physically - which is what
 * a seq scan does, and what produced the passing screenshot for four phases -
 * gives a different set and fails.
 */

let company: SeededCompany;
let fixture: { numberId: string; integrationId: string; contactIds: string[] };

/** One instant, shared by every row. The tie is the fixture. */
const TIED = new Date("2026-09-08T10:00:00.000Z");

/** Two more than the limit, so a tie at the boundary has something to drop. */
const OVER_LIMIT = DASHBOARD_LIST_LIMIT + 2;

/**
 * Ids whose ascending order is the REVERSE of the order the rows are written.
 *
 * This is what gives the test its teeth. If the readers relied on physical
 * order - a seq scan over a freshly-inserted table returns rows as they were
 * written - insertion order and id order would agree, every assertion would
 * pass, and removing the tiebreak would prove nothing.
 */
function tiedIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(count - 1 - i).padStart(3, "0")}`,
  );
}

/** The answer a total order must give: the lowest ids, ascending. */
function lowestAscending(ids: string[], count: number): string[] {
  return [...ids].sort().slice(0, count);
}

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("dashboard-ordering");

  fixture = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "ordering" },
      select: { id: true },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "pn-ordering",
        displayNumber: "+91 12345 00000",
        status: "CONNECTED",
        createdAt: TIED,
      },
      select: { id: true },
    });

    const contactIds: string[] = [];
    for (let i = 0; i < OVER_LIMIT; i += 1) {
      const suffix = String(i).padStart(5, "0");
      const contact = await db.contact.create({
        data: {
          companyId,
          waId: `9112345${suffix}`,
          phoneE164: `+9112345${suffix}`,
        },
        select: { id: true },
      });
      contactIds.push(contact.id);
    }

    return {
      numberId: number.id,
      integrationId: integration.id,
      contactIds,
    };
  });
});

/**
 * `OVER_LIMIT` conversations, every sort key identical, ids descending as
 * written.
 *
 * `extra` carries whatever the reader under test filters on, so each one gets
 * the same tie in the shape it needs.
 */
async function seedTiedConversations(
  prefix: string,
  extra: Record<string, unknown>,
): Promise<string[]> {
  const ids = tiedIds(prefix, OVER_LIMIT);

  await withCompany(company.id, async (db, companyId) => {
    for (const [i, id] of ids.entries()) {
      await db.conversation.create({
        data: {
          id,
          companyId,
          contactId: fixture.contactIds[i]!,
          whatsappNumberId: fixture.numberId,
          lastMessagePreview: `thread ${id}`,
          ...extra,
        },
      });
    }
  });

  return ids;
}

describe("a tie still has exactly one answer", () => {
  it("returns numbers in id order when created_at is identical", async () => {
    /*
     * The one reader with no LIMIT, so only the ORDER is at stake - and it is
     * the one the screenshot caught. Meta's refresh inserts an account's
     * numbers in a single pass; they tie, and the card promised in its own
     * comment that it would not reorder under the reader.
     */
    const ids = tiedIds("num", 3);

    await withCompany(company.id, async (db, companyId) => {
      for (const [i, id] of ids.entries()) {
        await db.whatsAppNumber.create({
          data: {
            id,
            companyId,
            integrationId: fixture.integrationId,
            phoneNumberId: `pn-tied-${i}`,
            displayNumber: `+91 98765 4321${i}`,
            status: "CONNECTED",
            createdAt: TIED,
          },
        });
      }
    });

    const health = await withCompany(company.id, (db) => numberHealth(db));

    /* The fixture's own number was created at TIED too, so it ties with all
       three and belongs in the same total order. */
    const expected = lowestAscending([...ids, fixture.numberId], 4);

    expect(health.map((row) => row.id)).toEqual(expected);
  });

  it("takes the same six recent threads every time, not any six", async () => {
    /*
     * THE assertion this file exists for. Eight threads tie on
     * last_message_at, the reader takes six, and without a tiebreak the two it
     * drops are whichever two the plan felt like - a different pair on a
     * different day, with nothing on screen to say so.
     */
    const ids = await seedTiedConversations("recent", { lastMessageAt: TIED });

    const threads = await withCompany(company.id, (db) =>
      recentThreads(db, { now: TIED }),
    );

    expect(threads).toHaveLength(DASHBOARD_LIST_LIMIT);
    expect(threads.map((thread) => thread.conversationId)).toEqual(
      lowestAscending(ids, DASHBOARD_LIST_LIMIT),
    );
  });

  it("takes the same six waiting threads every time", async () => {
    const ids = await seedTiedConversations("waiting", {
      lastMessageAt: TIED,
      unreadCount: 1,
    });

    /* No bounds argument: "waiting" is a property of the row, not of the
       clock - an unread thread is unread whatever time it is. */
    const waiting = await withCompany(company.id, (db) => waitingForAHuman(db));

    expect(waiting).toHaveLength(DASHBOARD_LIST_LIMIT);
    expect(waiting.map((thread) => thread.conversationId)).toEqual(
      lowestAscending(ids, DASHBOARD_LIST_LIMIT),
    );
  });

  it("takes the same six closing windows every time", async () => {
    /*
     * The tie here is the most ordinary of the five: a window expires exactly
     * 24 hours after the customer wrote, so any two customers who wrote in the
     * same millisecond expire in the same millisecond.
     */
    const closesAt = new Date(TIED.getTime() + 60 * 60 * 1000);
    const ids = await seedTiedConversations("closing", {
      lastMessageAt: TIED,
      lastInboundAt: TIED,
      windowExpiresAt: closesAt,
    });

    const closing = await withCompany(company.id, (db) =>
      closingWindows(db, {
        now: TIED,
        closingHorizon: new Date(TIED.getTime() + 6 * 60 * 60 * 1000),
      }),
    );

    expect(closing).toHaveLength(DASHBOARD_LIST_LIMIT);
    expect(closing.map((thread) => thread.conversationId)).toEqual(
      lowestAscending(ids, DASHBOARD_LIST_LIMIT),
    );
  });

  it("takes the same six pending templates every time", async () => {
    /*
     * Templates submitted together tie for the same reason numbers do: a
     * library is uploaded in one pass, and Meta answers them one at a time
     * afterwards.
     */
    const ids = tiedIds("tpl", OVER_LIMIT);

    await withCompany(company.id, async (db, companyId) => {
      for (const [i, id] of ids.entries()) {
        await db.whatsAppTemplate.create({
          data: {
            id,
            companyId,
            integrationId: fixture.integrationId,
            name: `pending_${i}`,
            language: "en_US",
            category: "UTILITY",
            status: "PENDING",
            components: [{ type: "BODY", text: "Waiting on Meta." }],
            createdAt: TIED,
          },
        });
      }
    });

    const pending = await withCompany(company.id, (db) => pendingTemplates(db));

    expect(pending).toHaveLength(DASHBOARD_LIST_LIMIT);
    expect(pending.map((template) => template.id)).toEqual(
      lowestAscending(ids, DASHBOARD_LIST_LIMIT),
    );
  });
});
