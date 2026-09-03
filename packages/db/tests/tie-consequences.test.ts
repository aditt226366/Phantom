import { beforeEach, describe, expect, it } from "vitest";

import {
  broadcastProgress,
  currentKycStatuses,
  listKycDocuments,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Two ties with consequences, neither of them under a LIMIT.
 *
 * ---------------------------------------------------------------------------
 * A tie does not need a limit to decide something
 * ---------------------------------------------------------------------------
 *
 * The limited reads are the sharp case - which rows are in the answer at all -
 * and they have their own tests. These two are the reason the sweep did not
 * stop there.
 *
 * `currentKycStatuses` reads every document and reduces to the NEWEST of each
 * kind. There is no limit anywhere; the reduction is the limit. Two documents
 * of one kind sharing a `created_at` make "newest" undefined, and the winner
 * decides `canUseFeatures` - which is the whole product. An APPROVED and a
 * REJECTED row tied to the microsecond means a company is verified or blocked
 * according to the query plan.
 *
 * `broadcastProgress` sorts failure reasons by count in JAVASCRIPT, and
 * `Array.prototype.sort` is stable - so two reasons with equal counts keep the
 * order they arrived in, which is the order an unordered `groupBy` handed back.
 * A SQL tiebreak would not have fixed it; the fix is a second sort key.
 */

let company: SeededCompany;

const TIED = new Date("2026-09-08T10:00:00.000Z");

/** A real PDF header - kyc_documents CHECKs the first five bytes. */
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("tie-consequences");
});

describe("the gate's own input, when two documents of one kind tie", () => {
  /**
   * Both GST, both at the same instant, one APPROVED and one REJECTED.
   *
   * Written with ids chosen so that the REJECTED row is the higher id and
   * therefore the winner under `id: "desc"`. That direction is deliberate: a
   * test whose expected answer is "allowed" could pass because the gate
   * defaulted open, and this one cannot.
   */
  async function seedTiedPair(): Promise<void> {
    await withCompany(company.id, async (db, companyId) => {
      for (const [id, status] of [
        ["kyc-aaa", "APPROVED"],
        ["kyc-zzz", "REJECTED"],
      ] as const) {
        await db.kycDocument.create({
          data: {
            id,
            companyId,
            kind: "GST",
            status,
            bytes: PDF,
            byteSize: PDF.length,
            sha256: `sha-${id}`,
            mimeType: "application/pdf",
            originalFilename: `${id}.pdf`,
            createdAt: TIED,
          },
        });
      }
    });
  }

  it("resolves the tie the same way every time", async () => {
    await seedTiedPair();

    const statuses = await withCompany(company.id, (db, companyId) =>
      currentKycStatuses(db, companyId),
    );

    /* kyc-zzz sorts first under id DESC, so its REJECTED is the newest. The
       value matters less than that it is always the same value. */
    expect(statuses.GST).toBe("REJECTED");
  });

  it("gives the same answer on repeated reads", async () => {
    /*
     * Weaker than the assertion above and worth having anyway: it is the
     * property a person would actually notice, and it holds without anybody
     * having to know which id wins.
     */
    await seedTiedPair();

    const reads = await Promise.all(
      Array.from({ length: 5 }, () =>
        withCompany(company.id, (db, companyId) =>
          currentKycStatuses(db, companyId),
        ),
      ),
    );

    expect(new Set(reads.map((read) => read.GST)).size).toBe(1);
  });

  it("lists every upload in a stable order", async () => {
    await seedTiedPair();

    const listed = await withCompany(company.id, (db, companyId) =>
      listKycDocuments(db, companyId),
    );

    expect(listed.map((document) => document.id)).toEqual(["kyc-zzz", "kyc-aaa"]);
  });
});

describe("the failure report, when two reasons have the same count", () => {
  /*
   * THIS ONE DOES NOT FAIL WITHOUT THE FIX, and that was measured rather than
   * assumed - twice, at two and at four tied reasons.
   *
   * Postgres plans a small `GROUP BY errorTitle` as a GroupAggregate over a
   * Sort, and that sort is on the grouping key - so the rows come back
   * alphabetically and the stable JavaScript sort preserves it. The comparator
   * with no tiebreak gets the right answer for a reason that has nothing to do
   * with the code: at a size that switches the planner to a HashAggregate, the
   * order becomes hash order and the report starts reshuffling.
   *
   * The fix is kept because relying on a plan choice is not a decision anybody
   * made, and this test is kept because it states the intended output. Neither
   * is a regression guard. Unlike the SQL cases there is no source-level check
   * that could be one either - `total-ordering.test.ts` reads orderBy clauses,
   * and this tie is in a comparator.
   */
  it("orders equal counts by title rather than by whatever the aggregate gave", async () => {
    const fixture = await withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "ties" },
        select: { id: true },
      });
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: "pn-ties",
          displayNumber: "+91 12345 00000",
          status: "CONNECTED",
        },
        select: { id: true },
      });
      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: "order_shipped",
          language: "en_US",
          category: "UTILITY",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Shipped." }],
        },
        select: { id: true },
      });
      const broadcast = await db.broadcast.create({
        data: {
          companyId,
          name: "September",
          templateId: template.id,
          whatsappNumberId: number.id,
          status: "RUNNING",
          gapMs: 1_000,
        },
        select: { id: true },
      });

      const contact = await db.contact.create({
        data: { companyId, waId: "911234500001", phoneE164: "+911234500001" },
        select: { id: true },
      });
      const conversation = await db.conversation.create({
        data: {
          companyId,
          contactId: contact.id,
          whatsappNumberId: number.id,
          source: "CAMPAIGN",
        },
        select: { id: true },
      });

      /* Four reasons, one failure each, so all four counts tie. */
      for (const title of [
        "Zeta refused",
        "Mu refused",
        "Alpha refused",
        "Kappa refused",
      ]) {
        await db.message.create({
          data: {
            companyId,
            conversationId: conversation.id,
            broadcastId: broadcast.id,
            direction: "OUTBOUND",
            status: "FAILED",
            type: "template",
            body: "Shipped.",
            errorTitle: title,
            occurredAt: TIED,
            sendAttempt: 1,
          },
        });
      }

      return { broadcastId: broadcast.id };
    });

    const progress = await withCompany(company.id, (db, companyId) =>
      broadcastProgress(db, companyId, fixture.broadcastId),
    );

    expect(progress.failures.map((failure) => failure.title)).toEqual([
      "Alpha refused",
      "Kappa refused",
      "Mu refused",
      "Zeta refused",
    ]);
    expect(progress.failures.every((failure) => failure.count === 1)).toBe(true);
  });
});
