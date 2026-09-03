import { beforeEach, describe, expect, it } from "vitest";
import {
  countMap,
  microsMap,
  readDashboardRollup,
  refreshDashboardRollup,
  withCompany,
} from "../src/index.ts";
import {
  seedCompany,
  superuserClient,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The refresh, checked against the rows it claims to describe.
 *
 * ---------------------------------------------------------------------------
 * Why every assertion here recomputes rather than restating
 * ---------------------------------------------------------------------------
 *
 * A dashboard aggregate is the least self-announcing thing in this system. A
 * FILTER clause that names the wrong status, a GROUP BY that drops a row, a
 * count that includes inbound in an outbound rate - none of them throw, none
 * make the page look broken, and all of them produce a figure a person will act
 * on. The only way to catch that class is to state the expected number twice
 * from two directions.
 *
 * So the fixtures below are small enough to count by hand, the expected values
 * are literals, and the totals are additionally checked against SQL run through
 * a superuser connection - ground truth, computed by a different statement from
 * the one under test.
 */

let company: SeededCompany;
let other: SeededCompany;

/** A fixed day boundary, so "today" is decided by the test and not the clock. */
const DAY_START = new Date("2026-09-01T18:30:00.000Z");
const MONTH_START = new Date("2026-08-31T18:30:00.000Z");
const COMPUTED_AT = new Date("2026-09-02T04:00:00.000Z");

/** Comfortably inside the day and month above. */
const TODAY = new Date("2026-09-01T20:00:00.000Z");
/** Before DAY_START, inside MONTH_START. */
const YESTERDAY = new Date("2026-09-01T10:00:00.000Z");
/** Before both. */
const LAST_MONTH = new Date("2026-08-20T10:00:00.000Z");

const BOUNDS = {
  computedAt: COMPUTED_AT,
  dayStart: DAY_START,
  monthStart: MONTH_START,
};

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("rollup");
  other = await seedCompany("neighbour");
});

interface MessageSpec {
  direction: "INBOUND" | "OUTBOUND";
  status?: string;
  occurredAt?: Date;
  errorCode?: number;
  errorSource?: "META" | "POLICY";
}

/**
 * One conversation with a named set of messages in it.
 *
 * Returns the conversation id so a test can add to it later, which is what the
 * reply assertions need: "the customer wrote back" is a fact about the ORDER of
 * two messages in one thread, not about their existence.
 */
async function seedThread(
  target: SeededCompany,
  label: string,
  messages: MessageSpec[],
  options: { createdAt?: Date; source?: string } = {},
): Promise<string> {
  return withCompany(target.id, async (db, companyId) => {
    /*
     * One integration and one number per company, reused across threads.
     * integrations is unique on (company_id, provider) and whatsapp_numbers on
     * (company_id, phone_number_id) - a second thread creating its own would
     * fail a constraint that has nothing to do with what is being tested.
     */
    const integration =
      (await db.integration.findFirst({
        where: { provider: "WHATSAPP_CLOUD" },
      })) ??
      (await db.integration.create({
        data: {
          companyId,
          provider: "WHATSAPP_CLOUD",
          label: "fixture integration",
          status: "CONNECTED",
        },
      }));

    const number =
      (await db.whatsAppNumber.findFirst({})) ??
      (await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: "pn_fixture",
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
      }));

    const contact = await db.contact.create({
      data: {
        companyId,
        waId: `wa_${label}`,
        phoneE164: "+919876543210",
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });

    const conversation = await db.conversation.create({
      data: {
        companyId,
        contactId: contact.id,
        whatsappNumberId: number.id,
        ...(options.source ? { source: options.source as "INBOUND" } : {}),
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });

    for (const [index, spec] of messages.entries()) {
      await db.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: spec.direction,
          status: (spec.status ?? "DELIVERED") as "DELIVERED",
          type: "text",
          body: `${label} ${index}`,
          occurredAt: spec.occurredAt ?? TODAY,
          ...(spec.errorCode !== undefined ? { errorCode: spec.errorCode } : {}),
          ...(spec.errorSource ? { errorSource: spec.errorSource } : {}),
        },
      });
    }

    return conversation.id;
  });
}

async function refresh(target: SeededCompany = company): Promise<void> {
  await withCompany(target.id, (db) => refreshDashboardRollup(db, BOUNDS));
}

async function read(target: SeededCompany = company) {
  const row = await withCompany(target.id, (db) =>
    readDashboardRollup(db, target.id),
  );
  expect(row, "the refresh wrote no row").not.toBeNull();
  return row!;
}

/** Ground truth, computed by a different statement than the one under test. */
async function countBySql(sql: string, companyId: string): Promise<number> {
  const pool = superuserClient();
  try {
    const { rows } = await pool.query<{ n: string }>(sql, [companyId]);
    return Number(rows[0]?.n ?? 0);
  } finally {
    await pool.end();
  }
}

describe("the message arithmetic", () => {
  it("partitions every message by direction and every outbound by status", async () => {
    await seedThread(company, "alpha", [
      { direction: "INBOUND" },
      { direction: "INBOUND" },
      { direction: "OUTBOUND", status: "READ" },
      { direction: "OUTBOUND", status: "DELIVERED" },
      { direction: "OUTBOUND", status: "SENT" },
      { direction: "OUTBOUND", status: "FAILED", errorCode: 131049 },
      { direction: "OUTBOUND", status: "HELD" },
      { direction: "OUTBOUND", status: "UNCONFIRMED" },
      { direction: "OUTBOUND", status: "PENDING" },
    ]);

    await refresh();
    const rollup = await read();

    /* Counted by hand off the fixture above. */
    expect(rollup.messagesTotal).toBe(9);
    expect(rollup.messagesInbound).toBe(2);
    expect(rollup.messagesOutbound).toBe(7);

    expect(rollup.outboundRead).toBe(1);
    expect(rollup.outboundDelivered).toBe(1);
    expect(rollup.outboundSent).toBe(1);
    expect(rollup.outboundFailed).toBe(1);
    expect(rollup.outboundHeld).toBe(1);
    expect(rollup.outboundUnconfirmed).toBe(1);
    expect(rollup.outboundPending).toBe(1);

    /*
     * And the same numbers from a statement that is not the one under test.
     * A FILTER clause naming the wrong column would satisfy the literals above
     * only if the fixture happened to agree; it cannot satisfy both.
     */
    expect(rollup.messagesTotal).toBe(
      await countBySql(
        `SELECT count(*) AS n FROM messages WHERE company_id = $1`,
        company.id,
      ),
    );
    expect(rollup.messagesOutbound).toBe(
      await countBySql(
        `SELECT count(*) AS n FROM messages
          WHERE company_id = $1 AND direction = 'OUTBOUND'`,
        company.id,
      ),
    );
  });

  it("counts nothing that belongs to another company", async () => {
    /*
     * The refresh runs inside withCompany with no company predicate of its own -
     * every FROM in it is scoped by the RLS policy and by nothing else. So this
     * is the assertion that the policy is what is doing the scoping, and it is
     * why the neighbour is seeded with MORE traffic than the subject.
     */
    await seedThread(company, "mine", [{ direction: "OUTBOUND" }]);
    await seedThread(other, "theirs", [
      { direction: "OUTBOUND" },
      { direction: "OUTBOUND" },
      { direction: "INBOUND" },
    ]);

    await refresh();
    const rollup = await read();

    expect(rollup.messagesTotal).toBe(1);
    expect(rollup.messagesInbound).toBe(0);
  });

  it("groups failures by Meta's code, and keeps our own refusals", async () => {
    await seedThread(company, "failures", [
      { direction: "OUTBOUND", status: "FAILED", errorCode: 131049 },
      { direction: "OUTBOUND", status: "FAILED", errorCode: 131049 },
      { direction: "OUTBOUND", status: "FAILED", errorCode: 131026 },
      { direction: "OUTBOUND", status: "FAILED", errorSource: "POLICY" },
      /* Not a failure, and must not appear in the map. */
      { direction: "OUTBOUND", status: "DELIVERED" },
    ]);

    await refresh();
    const rollup = await read();

    expect(countMap(rollup.failuresByCode)).toEqual({
      "131049": 2,
      "131026": 1,
      POLICY: 1,
    });

    /*
     * The property the page depends on: the breakdown totals to the failed
     * count beside it. A dropped key here renders as a chart whose parts do not
     * add up to its own heading.
     */
    const mapped = Object.values(countMap(rollup.failuresByCode)).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(mapped).toBe(rollup.outboundFailed);
  });
});

describe("who replied", () => {
  it("counts a thread the business opened and the customer answered", async () => {
    await seedThread(company, "answered", [
      { direction: "OUTBOUND", occurredAt: new Date("2026-09-01T09:00:00Z") },
      { direction: "INBOUND", occurredAt: new Date("2026-09-01T09:05:00Z") },
    ]);

    await refresh();
    const rollup = await read();

    expect(rollup.conversationsMessaged).toBe(1);
    expect(rollup.conversationsReplied).toBe(1);
  });

  it("does not count us answering a thread the customer started", async () => {
    /*
     * The asymmetry the refresh is built around, and the one an obvious
     * implementation gets wrong. Comparing the newest inbound against the
     * NEWEST outbound would call this a reply; comparing against the OLDEST
     * asks the question that was meant - did they write to us after we first
     * wrote to them.
     */
    await seedThread(company, "inbound-first", [
      { direction: "INBOUND", occurredAt: new Date("2026-09-01T09:00:00Z") },
      { direction: "OUTBOUND", occurredAt: new Date("2026-09-01T09:05:00Z") },
    ]);

    await refresh();
    const rollup = await read();

    expect(rollup.conversationsMessaged).toBe(1);
    expect(rollup.conversationsReplied).toBe(0);
  });

  it("still counts a reply when the business followed up afterwards", async () => {
    /*
     * The case that separates min from max, and the reason the first version of
     * this suite could not tell them apart: with one outbound per thread the
     * two are the same value, so the break-once probe swapping them passed.
     *
     * This is the ordinary shape of a working conversation - we write, they
     * answer, we answer them. Compared against the NEWEST outbound the customer
     * has not replied to us at all, and every business that follows up loses
     * its reply rate the moment it does so.
     */
    await seedThread(company, "followed-up", [
      { direction: "OUTBOUND", occurredAt: new Date("2026-09-01T09:00:00Z") },
      { direction: "INBOUND", occurredAt: new Date("2026-09-01T09:05:00Z") },
      { direction: "OUTBOUND", occurredAt: new Date("2026-09-01T09:10:00Z") },
    ]);

    await refresh();
    const rollup = await read();

    expect(rollup.conversationsMessaged).toBe(1);
    expect(rollup.conversationsReplied).toBe(1);
  });

  it("does not count a thread nobody has been messaged in", async () => {
    await seedThread(company, "inbound-only", [{ direction: "INBOUND" }]);

    await refresh();
    const rollup = await read();

    expect(rollup.conversationsMessaged).toBe(0);
    expect(rollup.conversationsReplied).toBe(0);
  });
});

describe("the platform day", () => {
  it("counts against the boundary it was given, not the clock", async () => {
    await seedThread(company, "today", [{ direction: "INBOUND" }], {
      createdAt: TODAY,
    });
    await seedThread(company, "yesterday", [{ direction: "INBOUND" }], {
      createdAt: YESTERDAY,
    });

    await refresh();
    const rollup = await read();

    /*
     * YESTERDAY is 10:00 UTC on 1 September, which is 15:30 IST on the SAME
     * calendar day in UTC terms and the PREVIOUS platform day. A boundary
     * computed at UTC midnight would count both, and the difference between
     * "1 new today" and "2 new today" is exactly the fault this is here for.
     */
    expect(rollup.conversationsTotal).toBe(2);
    expect(rollup.conversationsNewToday).toBe(1);
    expect(rollup.contactsTotal).toBe(2);
    expect(rollup.contactsNewToday).toBe(1);
  });

  it("stamps the boundaries it counted against", async () => {
    await refresh();
    const rollup = await read();

    /* Exact instants, never a tolerance: a tolerant comparison passes on a UTC
       machine and hides every timezone fault on all the others. */
    expect(rollup.dayStart.toISOString()).toBe(DAY_START.toISOString());
    expect(rollup.monthStart.toISOString()).toBe(MONTH_START.toISOString());
    expect(rollup.computedAt.toISOString()).toBe(COMPUTED_AT.toISOString());
  });

  it("distributes conversations by source", async () => {
    await seedThread(company, "organic", [{ direction: "INBOUND" }], {
      source: "INBOUND",
    });
    await seedThread(company, "campaign-a", [{ direction: "OUTBOUND" }], {
      source: "CAMPAIGN",
    });
    await seedThread(company, "campaign-b", [{ direction: "OUTBOUND" }], {
      source: "CAMPAIGN",
    });

    await refresh();
    const rollup = await read();

    expect(countMap(rollup.conversationsBySource)).toEqual({
      INBOUND: 1,
      CAMPAIGN: 2,
    });
  });
});

describe("money", () => {
  async function seedUsage(
    target: SeededCompany,
    events: Array<{
      kind: string;
      costMicros: bigint | null;
      currency: string | null;
      occurredAt: Date;
    }>,
  ): Promise<void> {
    await withCompany(target.id, async (db, companyId) => {
      for (const [index, event] of events.entries()) {
        await db.usageEvent.create({
          data: {
            companyId,
            kind: event.kind,
            quantity: 1,
            costMicros: event.costMicros,
            currency: event.currency,
            priceVersion: 1,
            dedupeKey: `${event.kind}-${index}-${event.occurredAt.toISOString()}`,
            occurredAt: event.occurredAt,
            ...(event.costMicros === null
              ? { unpricedReason: "no_price_entry" }
              : {}),
          },
        });
      }
    });
  }

  it("keeps two currencies apart and never adds them", async () => {
    await seedUsage(company, [
      { kind: "a", costMicros: 4_000_000n, currency: "INR", occurredAt: TODAY },
      { kind: "b", costMicros: 1_500_000n, currency: "INR", occurredAt: TODAY },
      { kind: "c", costMicros: 50_000n, currency: "USD", occurredAt: TODAY },
    ]);

    await refresh();
    const rollup = await read();

    /*
     * Two entries, not one. There is no exchange rate in this system, and the
     * failure this guards is a column that sums cost_micros across currencies
     * and produces a number denominated in nothing - which renders with exactly
     * the same authority as a correct one.
     */
    expect(microsMap(rollup.costByCurrency)).toEqual({
      INR: "5500000",
      USD: "50000",
    });
  });

  it("keeps every digit of a figure past what a double holds", async () => {
    /*
     * The reason the values are text. jsonb numbers are IEEE doubles;
     * cost_micros is a bigint. This value is 2^53 + 1, the first integer a
     * double cannot represent - stored as a number it would come back as
     * ...992 and nothing would say so.
     */
    await seedUsage(company, [
      {
        kind: "large",
        costMicros: 9_007_199_254_740_993n,
        currency: "INR",
        occurredAt: TODAY,
      },
    ]);

    await refresh();
    const rollup = await read();

    expect(microsMap(rollup.costByCurrency)["INR"]).toBe("9007199254740993");
  });

  it("counts unpriced events separately rather than as free", async () => {
    await seedUsage(company, [
      { kind: "a", costMicros: 4_000_000n, currency: "INR", occurredAt: TODAY },
      { kind: "b", costMicros: null, currency: null, occurredAt: TODAY },
      { kind: "c", costMicros: null, currency: null, occurredAt: TODAY },
    ]);

    await refresh();
    const rollup = await read();

    /* SUM ignores nulls, so an unpriced event lowers no total - it just has to
       be reported, or the month reads as complete when part of it was never
       priced at all. */
    expect(microsMap(rollup.costByCurrency)).toEqual({ INR: "4000000" });
    expect(rollup.costUnpricedCount).toBe(2);
  });

  it("does not count ad spend as unpriced platform usage", async () => {
    /*
     * meta.ad.spend carries a null cost on purpose, and it is the one kind
     * here that does NOT mean "we have not priced this yet". The money is
     * Meta's, already charged to the tenant, in the ad account's own currency,
     * and the figure lives on the insight row where it can be read per
     * currency without anything summing across them.
     *
     * Counting it would make "N events have no price yet" read as OUR pricing
     * being incomplete - on the one card whose entire job is to be honest
     * about what a total is missing. That card was correct when Phase 7 wrote
     * it, and this phase would have made it lie: exactly the obligation
     * spec-amendments records, which is to check the copy of the cards a phase
     * does NOT replace.
     */
    await seedUsage(company, [
      { kind: "a", costMicros: 4_000_000n, currency: "INR", occurredAt: TODAY },
      { kind: "b", costMicros: null, currency: null, occurredAt: TODAY },
      { kind: "meta.ad.spend", costMicros: null, currency: null, occurredAt: TODAY },
      { kind: "meta.ad.spend", costMicros: null, currency: null, occurredAt: TODAY },
    ]);

    await refresh();
    const rollup = await read();

    /* One, not three. */
    expect(rollup.costUnpricedCount).toBe(1);
  });

  it("excludes spend from before the month boundary", async () => {
    await seedUsage(company, [
      { kind: "a", costMicros: 4_000_000n, currency: "INR", occurredAt: TODAY },
      {
        kind: "b",
        costMicros: 9_000_000n,
        currency: "INR",
        occurredAt: LAST_MONTH,
      },
      { kind: "c", costMicros: null, currency: null, occurredAt: LAST_MONTH },
    ]);

    await refresh();
    const rollup = await read();

    expect(microsMap(rollup.costByCurrency)).toEqual({ INR: "4000000" });
    expect(rollup.costUnpricedCount).toBe(0);
  });
});

describe("the upsert", () => {
  it("replaces the previous row rather than accumulating", async () => {
    await seedThread(company, "first", [{ direction: "INBOUND" }]);
    await refresh();

    await seedThread(company, "second", [{ direction: "INBOUND" }]);
    await refresh();

    const rollup = await read();
    expect(rollup.messagesTotal).toBe(2);

    const rows = await countBySql(
      `SELECT count(*) AS n FROM dashboard_rollups WHERE company_id = $1`,
      company.id,
    );
    expect(rows, "one row per company, by primary key").toBe(1);
  });

  it("writes the company from the transaction scope, not from a parameter", async () => {
    /*
     * The row's tenancy comes from app_current_company(), which is the same
     * value RLS reads. They cannot disagree, which is the point of taking it
     * from there rather than binding it - a mismatched parameter would be
     * refused by the WITH CHECK, but only if somebody remembered to pass the
     * right one.
     */
    await refresh();

    const pool = superuserClient();
    try {
      const { rows } = await pool.query<{ company_id: string }>(
        `SELECT company_id FROM dashboard_rollups`,
      );
      expect(rows.map((row) => row.company_id)).toEqual([company.id]);
    } finally {
      await pool.end();
    }
  });

  it("counts lead temperature, and never counts unscored as cold", async () => {
    /*
     * The distinction the whole card rests on. A contact nothing has scored is
     * absent from the map rather than counted under a fourth key: unscored
     * means no flow has ever asked them anything, and reporting it as COLD
     * would tell a business its entire contact book was uninterested.
     */
    await seedThread(company, "hot", [{ direction: "INBOUND" }]);
    await seedThread(company, "unscored", [{ direction: "INBOUND" }]);

    const contacts = await withCompany(company.id, (db) =>
      db.contact.findMany({ orderBy: { waId: "asc" }, select: { id: true } }),
    );

    await withCompany(company.id, (db) =>
      db.contact.update({
        where: { id: contacts[0]!.id },
        data: { leadScore: "HOT", leadScoreAt: new Date() },
      }),
    );

    await refresh();
    const rollup = await read();

    expect(countMap(rollup.contactsByScore)).toEqual({ HOT: 1 });
    /* Two contacts, one scored. The card prints the difference as a caption. */
    expect(rollup.contactsTotal).toBe(2);
  });

  it("counts a conversation a flow stood in, once, however many runs it held", async () => {
    /*
     * DISTINCT over flow_runs rather than a count of them. A customer who came
     * back next month has two runs in one conversation, and counting runs
     * would report more automated threads than the tenant has threads - which
     * the CHECK in 20260906120000 refuses outright rather than rendering as a
     * bar drawn off the end of its track.
     */
    const conversationId = await seedThread(company, "automated", [
      { direction: "INBOUND" },
    ]);

    await withCompany(company.id, async (db, companyId) => {
      const conversation = await db.conversation.findFirstOrThrow({
        where: { id: conversationId },
        select: { id: true, contactId: true, whatsappNumberId: true },
      });

      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: (
            await db.integration.findFirstOrThrow({ select: { id: true } })
          ).id,
          name: "flow_entry",
          language: "en_US",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hello" }],
        },
        select: { id: true },
      });

      const flow = await db.flow.create({
        data: { companyId, name: "Enquiry" },
        select: { id: true },
      });

      const version = await db.flowVersion.create({
        data: {
          companyId,
          flowId: flow.id,
          version: 1,
          entryTemplateId: template.id,
          graph: { entryNodeId: "start", nodes: [] },
        },
        select: { id: true },
      });

      /* Two runs, one conversation: the customer came back. */
      for (const seq of [1, 2]) {
        await db.flowRun.create({
          data: {
            companyId,
            flowId: flow.id,
            flowVersionId: version.id,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            status: "COMPLETED",
            currentNodeId: null,
            activeConversationId: null,
            endedAt: new Date(Date.now() + seq),
          },
        });
      }
    });

    await refresh();
    const rollup = await read();

    expect(rollup.conversationsAutomated).toBe(1);
    expect(rollup.conversationsAutomated).toBeLessThanOrEqual(
      rollup.conversationsTotal,
    );
  });

  it("is empty and honest for a company with no traffic at all", async () => {
    await refresh();
    const rollup = await read();

    expect(rollup.messagesTotal).toBe(0);
    expect(countMap(rollup.failuresByCode)).toEqual({});
    expect(microsMap(rollup.costByCurrency)).toEqual({});
    expect(countMap(rollup.contactsByScore)).toEqual({});
    expect(rollup.conversationsAutomated).toBe(0);
    /* A row that exists and says zero is a different claim from no row at all,
       and the page renders them differently. */
    expect(rollup.computedAt.toISOString()).toBe(COMPUTED_AT.toISOString());
  });
});
