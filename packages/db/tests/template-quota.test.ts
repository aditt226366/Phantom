import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyTemplateStatus,
  recordTemplateEdit,
  TEMPLATE_EDIT_LIMIT,
  TEMPLATE_EDIT_WINDOW_DAYS,
  templateEditQuota,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The edit quota, and what it is not.
 *
 * It is counted from whatsapp_template_edits on every read. There is no counter
 * column, because a counter is a second source of truth for something the rows
 * already say and it is wrong the first time a write half-fails - after which
 * nothing notices, since there is nothing left to compare it against.
 *
 * And it is a FLOOR (R8). Meta counts edits made in Business Manager and those
 * never arrive here, so this number is always less than or equal to Meta's. The
 * tests below fix the arithmetic; the label and the ungated Edit button are what
 * make the gap honest, and those live in the Studio.
 */

let company: SeededCompany;
let templateId: string;

const NOW = new Date("2026-08-27T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("quota");

  templateId = await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
      select: { id: true },
    });

    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: "order_update",
        language: "en_US",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hi {{1}}, it shipped." }],
        metaTemplateId: "meta-1",
      },
      select: { id: true },
    });

    return template.id;
  });
});

afterAll(async () => {
  await truncateAll();
});

/** Append an edit stamped at a chosen instant. */
async function editAt(at: Date): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    await db.whatsAppTemplateEdit.create({
      data: {
        companyId,
        templateId,
        components: [{ type: "BODY", text: "Hi {{1}}, it shipped." }],
        createdAt: at,
      },
    });
  });
}

describe("templateEditQuota", () => {
  it("counts nothing for a template nobody has edited", async () => {
    const quota = await withCompany(company.id, (db, companyId) =>
      templateEditQuota(db, companyId, templateId, NOW),
    );

    expect(quota).toEqual({ used: 0, limit: TEMPLATE_EDIT_LIMIT, oldestAt: null });
  });

  it("counts the edits inside the window", async () => {
    await editAt(new Date(NOW.getTime() - 2 * DAY));
    await editAt(new Date(NOW.getTime() - 1 * DAY));

    const quota = await withCompany(company.id, (db, companyId) =>
      templateEditQuota(db, companyId, templateId, NOW),
    );

    expect(quota.used).toBe(2);
  });

  /*
   * The window rolls. An edit that has aged out stops counting, which is what
   * makes "you have run out" a temporary state rather than a permanent one -
   * and oldestAt is what tells somebody when it changes.
   */
  it("forgets an edit older than the window", async () => {
    await editAt(new Date(NOW.getTime() - (TEMPLATE_EDIT_WINDOW_DAYS + 1) * DAY));
    await editAt(new Date(NOW.getTime() - 1 * DAY));

    const quota = await withCompany(company.id, (db, companyId) =>
      templateEditQuota(db, companyId, templateId, NOW),
    );

    expect(quota.used).toBe(1);
    expect(quota.oldestAt?.toISOString()).toBe(
      new Date(NOW.getTime() - 1 * DAY).toISOString(),
    );
  });

  /*
   * The quota is per template, not per company. Sharing it would let a busy
   * template lock somebody out of fixing a rejected one, which is exactly when
   * an edit matters most.
   */
  it("does not count another template's edits", async () => {
    const otherId = await withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.findFirstOrThrow({ select: { id: true } });
      const other = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: "other_template",
          language: "en_US",
          category: "UTILITY",
          components: [],
        },
        select: { id: true },
      });
      return other.id;
    });

    await editAt(new Date(NOW.getTime() - 1 * DAY));

    const quota = await withCompany(company.id, (db, companyId) =>
      templateEditQuota(db, companyId, otherId, NOW),
    );

    expect(quota.used).toBe(0);
  });

  it("is derived, so an appended edit changes it with nothing else written", async () => {
    await withCompany(company.id, (db, companyId) =>
      recordTemplateEdit(db, companyId, {
        templateId,
        components: [{ type: "BODY", text: "changed" }],
        editedByUserId: null,
      }),
    );

    const quota = await withCompany(company.id, (db, companyId) =>
      templateEditQuota(db, companyId, templateId, new Date()),
    );

    expect(quota.used).toBe(1);
  });
});

describe("applyTemplateStatus", () => {
  it("matches on Meta's id and records the reason verbatim", async () => {
    const applied = await withCompany(company.id, (db, companyId) =>
      applyTemplateStatus(db, companyId, {
        metaTemplateId: "meta-1",
        status: "REJECTED",
        rejectedReason: "INVALID_FORMAT",
        category: null,
        at: NOW,
      }),
    );

    expect(applied).toBe(true);

    const row = await withCompany(company.id, (db) =>
      db.whatsAppTemplate.findFirstOrThrow({
        select: { status: true, rejectedReason: true, statusUpdatedAt: true },
      }),
    );

    expect(row).toMatchObject({ status: "REJECTED", rejectedReason: "INVALID_FORMAT" });
    expect(row.statusUpdatedAt?.toISOString()).toBe(NOW.toISOString());
  });

  /*
   * A template that was rejected, fixed and approved must not keep last time's
   * reason under an APPROVED badge - the same argument the message retry makes
   * about clearing a failure's error columns.
   */
  it("clears the reason when the update is not a rejection", async () => {
    await withCompany(company.id, (db, companyId) =>
      applyTemplateStatus(db, companyId, {
        metaTemplateId: "meta-1",
        status: "REJECTED",
        rejectedReason: "INVALID_FORMAT",
        category: null,
        at: NOW,
      }),
    );

    await withCompany(company.id, (db, companyId) =>
      applyTemplateStatus(db, companyId, {
        metaTemplateId: "meta-1",
        status: "APPROVED",
        rejectedReason: null,
        category: null,
        at: NOW,
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.whatsAppTemplate.findFirstOrThrow({
        select: { status: true, rejectedReason: true },
      }),
    );

    expect(row).toEqual({ status: "APPROVED", rejectedReason: null });
  });

  /* Meta re-categorises on wording, and the price follows. */
  it("follows a re-categorisation when the callback carries one", async () => {
    await withCompany(company.id, (db, companyId) =>
      applyTemplateStatus(db, companyId, {
        metaTemplateId: "meta-1",
        status: "APPROVED",
        rejectedReason: null,
        category: "MARKETING",
        at: NOW,
      }),
    );

    const row = await withCompany(company.id, (db) =>
      db.whatsAppTemplate.findFirstOrThrow({ select: { category: true } }),
    );

    expect(row.category).toBe("MARKETING");
  });

  /*
   * A WABA holds templates created in Business Manager that this system has
   * never seen, and Meta sends callbacks for those too. Not an error - the
   * caller needs to tell it apart from a failed write, which is why this
   * returns a boolean rather than throwing.
   */
  it("reports a template it does not hold rather than failing", async () => {
    const applied = await withCompany(company.id, (db, companyId) =>
      applyTemplateStatus(db, companyId, {
        metaTemplateId: "never-seen",
        status: "APPROVED",
        rejectedReason: null,
        category: null,
        at: NOW,
      }),
    );

    expect(applied).toBe(false);
  });
});
