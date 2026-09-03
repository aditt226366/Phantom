import { beforeEach, describe, expect, it } from "vitest";

import { recordConversationCharge, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Meta's per-conversation charge, which nothing recorded for five phases.
 *
 * ---------------------------------------------------------------------------
 * What was missing, and what was not
 * ---------------------------------------------------------------------------
 *
 * Not the data. `payload.ts` has parsed `pricing.billable` and
 * `pricing.category` off the status callback since Phase 4, and
 * `conversationUsageKind` existed to map a category to a usage kind and was
 * called from a test and nowhere else. The webhook read the values and dropped
 * them.
 *
 * So four usage kinds sat declared and priced with nothing writing one, and the
 * largest real cost in the product went unattributed - in a system whose
 * argument for holding platform-level provider keys is that every call is
 * attributed to the company that caused it.
 *
 * ---------------------------------------------------------------------------
 * This file is named evidence
 * ---------------------------------------------------------------------------
 *
 * `usage-kinds-wired.test.ts` cannot see these four kinds: they are written
 * from a computed expression, because the category arrives from Meta at
 * runtime. Its COMPUTED_KIND_SITES map names this file as the proof, and
 * asserts that it exists and mentions each kind. So the four assertions below
 * are load-bearing for that check as well as for themselves.
 */

let company: SeededCompany;

const AT = new Date("2026-09-08T10:00:00.000Z");

/** The four categories Meta sends, and the kind each must produce. */
const CATEGORIES = [
  ["marketing", "whatsapp.conversation.marketing"],
  ["utility", "whatsapp.conversation.utility"],
  ["authentication", "whatsapp.conversation.authentication"],
  ["service", "whatsapp.conversation.service"],
] as const;

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("conversation-charges");
});

function charge(over: Partial<Parameters<typeof recordConversationCharge>[2]> = {}) {
  return withCompany(company.id, (db, companyId) =>
    recordConversationCharge(db, companyId, {
      metaConversationId: "conv-1",
      category: "marketing",
      pricingModel: "CBP",
      billable: true,
      wamid: "wamid.AAA",
      occurredAt: AT,
      ...over,
    }),
  );
}

function usageRows() {
  return withCompany(company.id, (db, companyId) =>
    db.usageEvent.findMany({
      where: { companyId },
      orderBy: [{ kind: "asc" }, { id: "asc" }],
      select: {
        kind: true,
        dedupeKey: true,
        occurredAt: true,
        inputTokens: true,
        outputTokens: true,
      },
    }),
  );
}

describe("every category Meta sends becomes its own kind", () => {
  it.each(CATEGORIES)("records %s as %s", async (category, kind) => {
    const result = await charge({
      category,
      metaConversationId: `conv-${category}`,
    });

    expect(result.usageRecorded).toBe(true);

    const rows = await usageRows();
    expect(rows.map((row) => row.kind)).toEqual([kind]);
    /* Meta's instant, not now(). A backfill reading a payload stored months ago
       must land on the original moment or a quarter's spend moves. */
    expect(rows[0]!.occurredAt).toEqual(AT);
  });

  it("leaves the token columns null, because Meta bills per conversation", async () => {
    /*
     * Not zero. There are no tokens in a conversation charge at all - the
     * concept does not apply - and a zero would claim the call consumed none of
     * something it cannot consume, then sum as though it had been measured.
     */
    await charge();

    const rows = await usageRows();
    expect(rows[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});

describe("one window, however many callbacks", () => {
  it("charges once for the same conversation id", async () => {
    /*
     * THE assertion. A 24-hour window of ten messages produces roughly thirty
     * status callbacks - sent, delivered and read for each - every one carrying
     * the same conversation id and the same pricing block. Keyed per message
     * this would bill thirty times, into the table that becomes an invoice.
     */
    const first = await charge({ wamid: "wamid.AAA" });
    const second = await charge({ wamid: "wamid.BBB" });
    const third = await charge({ wamid: "wamid.CCC" });

    expect(first.usageRecorded).toBe(true);
    expect(second.usageRecorded).toBe(false);
    expect(second.skipped).toBe("already_recorded");
    expect(third.usageRecorded).toBe(false);

    expect(await usageRows()).toHaveLength(1);

    const charges = await withCompany(company.id, (db, companyId) =>
      db.whatsAppConversationCharge.count({ where: { companyId } }),
    );
    expect(charges).toBe(1);
  });

  it("keeps the first sighting's instant, not the last callback's", async () => {
    /* The charge belongs to when the window opened. A `read` receipt arriving
       eighteen hours later must not move the spend to the following day. */
    await charge({ occurredAt: AT });
    await charge({ occurredAt: new Date("2026-09-09T04:00:00.000Z") });

    const rows = await usageRows();
    expect(rows[0]!.occurredAt).toEqual(AT);
  });
});

describe("what Meta said, kept verbatim", () => {
  it("stores the category, the pricing model and billable", async () => {
    await charge({ category: "utility", pricingModel: "PMP" });

    const row = await withCompany(company.id, (db, companyId) =>
      db.whatsAppConversationCharge.findFirstOrThrow({
        where: { companyId, metaConversationId: "conv-1" },
        select: {
          category: true,
          pricingModel: true,
          billable: true,
          firstWamid: true,
          occurredAt: true,
        },
      }),
    );

    expect(row).toEqual({
      category: "utility",
      pricingModel: "PMP",
      billable: true,
      firstWamid: "wamid.AAA",
      occurredAt: AT,
    });
  });

  it("records a non-billable window without charging for it", async () => {
    /*
     * A free-tier service window is real and is not a charge. "We had no
     * marketing conversations" and "we had eleven and Meta billed none" are
     * different businesses, and only the row can tell them apart.
     */
    const result = await charge({ billable: false });

    expect(result.chargeCreated).toBe(true);
    expect(result.usageRecorded).toBe(false);
    expect(result.skipped).toBe("not_billable");

    expect(await usageRows()).toEqual([]);
  });

  it("stores a category it does not model, and charges nothing for it", async () => {
    /*
     * Meta has added conversation categories before and will again. Folding an
     * unknown one into `service` because it is cheapest understates a bill;
     * folding it into `marketing` overstates it. The window is recorded with
     * the category verbatim, so a new member is a question this table can
     * answer rather than a gap it hides.
     */
    const result = await charge({ category: "referral_conversion" });

    expect(result.usageRecorded).toBe(false);
    expect(result.skipped).toBe("unknown_category");
    expect(await usageRows()).toEqual([]);

    const row = await withCompany(company.id, (db, companyId) =>
      db.whatsAppConversationCharge.findFirstOrThrow({
        where: { companyId, metaConversationId: "conv-1" },
        select: { category: true, billable: true },
      }),
    );
    expect(row).toEqual({ category: "referral_conversion", billable: true });
  });
});

describe("a later callback completes the row without un-saying it", () => {
  it("fills a category the first callback did not carry, and charges then", async () => {
    /*
     * Meta omits the pricing block on some statuses - a `sent` can carry none
     * where the `delivered` that follows does. The window is recorded bare and
     * completed later, and the charge lands when the category finally arrives.
     */
    const bare = await charge({ category: null, pricingModel: null, billable: false });
    expect(bare.usageRecorded).toBe(false);

    const later = await charge({ category: "marketing", billable: true });
    expect(later.usageRecorded).toBe(true);

    const rows = await usageRows();
    expect(rows.map((row) => row.kind)).toEqual([
      "whatsapp.conversation.marketing",
    ]);
  });

  it("does not blank a category a later callback omits", async () => {
    /*
     * The direction that would lose money quietly. A callback with no pricing
     * block must not erase what an earlier one told us, or the last status of
     * every window - usually `read`, which often carries nothing - would wipe
     * the category off the whole month.
     */
    await charge({ category: "utility", pricingModel: "CBP", billable: true });
    await charge({ category: null, pricingModel: null, billable: false });

    const row = await withCompany(company.id, (db, companyId) =>
      db.whatsAppConversationCharge.findFirstOrThrow({
        where: { companyId, metaConversationId: "conv-1" },
        select: { category: true, pricingModel: true, billable: true },
      }),
    );

    expect(row).toEqual({
      category: "utility",
      pricingModel: "CBP",
      billable: true,
    });
  });
});
