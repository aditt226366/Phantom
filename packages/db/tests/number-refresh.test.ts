import type { WhatsAppNumberFacts } from "@whatsapp-os/core/whatsapp";
import { beforeEach, describe, expect, it } from "vitest";
import { MISSING_FROM_META_LIST, applyNumberRefresh, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * What a refresh does to the stored numbers, and what it refuses to do.
 *
 * Against a real database, because the rule that matters is about a row that
 * is NOT deleted and a timestamp that is NOT overwritten - both of which a
 * mocked client would report however the code asked.
 */

let alpha: SeededCompany;
let integrationId: string;

const T0 = new Date("2026-08-16T09:00:00.000Z");
const T1 = new Date("2026-08-16T10:00:00.000Z");
const T2 = new Date("2026-08-16T11:00:00.000Z");

function facts(over: Partial<WhatsAppNumberFacts> = {}): WhatsAppNumberFacts {
  return {
    phoneNumberId: "pn-1",
    displayNumber: "+91 98765 43210",
    verifiedName: "Alpha Ltd",
    qualityRating: "GREEN",
    messagingTier: "TIER_1K",
    throughputLevel: "STANDARD",
    status: "CONNECTED",
    ...over,
  };
}

function apply(fetched: WhatsAppNumberFacts[], now: Date) {
  return withCompany(alpha.id, (db, companyId) =>
    applyNumberRefresh(db, companyId, integrationId, fetched, now),
  );
}

function numbers() {
  return withCompany(alpha.id, (db) =>
    db.whatsAppNumber.findMany({ orderBy: { phoneNumberId: "asc" } }),
  );
}

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");

  integrationId = await withCompany(alpha.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
    });
    return integration.id;
  });
});

describe("a refresh that finds everything", () => {
  it("caches what Meta said, and stamps when it said it", async () => {
    const counts = await apply([facts()], T0);

    expect(counts).toEqual({ refreshed: 1, added: 1, missing: 0, restored: 0 });

    const [row] = await numbers();
    expect(row?.displayNumber).toBe("+91 98765 43210");
    expect(row?.verifiedName).toBe("Alpha Ltd");
    expect(row?.qualityRating).toBe("GREEN");
    expect(row?.messagingTier).toBe("TIER_1K");
    expect(row?.status).toBe("CONNECTED");
    /* The age of the answer, which is what the page shows instead of fetching
       one itself. */
    expect(row?.metadataRefreshedAt?.toISOString()).toBe(T0.toISOString());
  });

  it("updates a number it already holds rather than adding a second", async () => {
    await apply([facts()], T0);
    const counts = await apply(
      [facts({ qualityRating: "RED", messagingTier: "TIER_10K" })],
      T1,
    );

    expect(counts).toEqual({ refreshed: 1, added: 0, missing: 0, restored: 0 });

    const rows = await numbers();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qualityRating).toBe("RED");
    expect(rows[0]?.messagingTier).toBe("TIER_10K");
    expect(rows[0]?.metadataRefreshedAt?.toISOString()).toBe(T1.toISOString());
  });

  it("stores a status Meta invented verbatim", async () => {
    await apply([facts({ status: "RATE_LIMITED" })], T0);

    /* Text since 20260816100000. The enum would have flattened this to UNKNOWN
       and lost the one fact an operator can act on. */
    expect((await numbers())[0]?.status).toBe("RATE_LIMITED");
  });
});

describe("a number Meta stops returning", () => {
  it("is marked, not deleted", async () => {
    await apply([facts(), facts({ phoneNumberId: "pn-2" })], T0);

    const counts = await apply([facts()], T1);

    expect(counts).toEqual({ refreshed: 1, added: 0, missing: 1, restored: 0 });

    /*
     * The row survives. Deleting it would take every conversation that
     * references it, on the evidence of a field not being in a list - and
     * "removed in Business Manager" and "the call came back short" look
     * identical from here.
     */
    const rows = await numbers();
    expect(rows).toHaveLength(2);

    const gone = rows.find((row) => row.phoneNumberId === "pn-2");
    expect(gone?.missingSince?.toISOString()).toBe(T1.toISOString());
    expect(gone?.missingReason).toBe(MISSING_FROM_META_LIST);
  });

  it("keeps the date it first went missing across later refreshes", async () => {
    await apply([facts(), facts({ phoneNumberId: "pn-2" })], T0);
    await apply([facts()], T1);
    await apply([facts()], T2);

    /*
     * Two minutes missing and two weeks missing are different situations, and
     * only the first-seen timestamp can tell them apart. Restamping it every
     * refresh would make a long absence look new for ever.
     */
    const gone = (await numbers()).find((row) => row.phoneNumberId === "pn-2");
    expect(gone?.missingSince?.toISOString()).toBe(T1.toISOString());
  });

  it("is unmarked the moment Meta returns it again", async () => {
    await apply([facts(), facts({ phoneNumberId: "pn-2" })], T0);
    await apply([facts()], T1);

    const counts = await apply([facts(), facts({ phoneNumberId: "pn-2" })], T2);

    /* Which is what makes a transient absence self-correcting rather than a
       permanent mark somebody has to clear by hand. */
    expect(counts.restored).toBe(1);

    const back = (await numbers()).find((row) => row.phoneNumberId === "pn-2");
    expect(back?.missingSince).toBeNull();
    expect(back?.missingReason).toBeNull();
  });

  it("marks every number when Meta returns an empty list, and still deletes none", async () => {
    await apply([facts(), facts({ phoneNumberId: "pn-2" })], T0);

    const counts = await apply([], T1);

    expect(counts.missing).toBe(2);
    expect(await numbers()).toHaveLength(2);
  });
});

describe("another company's numbers", () => {
  it("are not touched by a refresh", async () => {
    const beta = await seedCompany("beta");

    const betaIntegration = await withCompany(beta.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
      });
      await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: "pn-beta",
          displayNumber: "+91 90000 00000",
        },
      });
      return integration.id;
    });

    /* Alpha refreshes and finds one number; beta's is not in that answer and
       must not be marked missing by it. */
    await apply([facts()], T0);

    const betaRows = await withCompany(beta.id, (db) =>
      db.whatsAppNumber.findMany({ where: { integrationId: betaIntegration } }),
    );

    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]?.missingSince).toBeNull();
  });
});
