import { beforeEach, describe, expect, it } from "vitest";
import { resolveCompany, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The seventh lookup kind, which is how a company id exists for a request that
 * has no session.
 *
 * A wrong answer here is not a bug in one query. app_resolve_company's result
 * goes straight to withCompany, which sets the value every policy in the schema
 * trusts - so a key that resolved to the wrong company would open that
 * company's scope to a request from the internet.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

async function seedBinding(
  company: SeededCompany,
  label: string,
): Promise<{ id: string; webhookKey: string }> {
  return withCompany(company.id, async (db, companyId) => {
    /* One per company: the provider is unique per company, so a second
       binding in the same company reuses it. */
    const integration =
      (await db.integration.findFirst({
        where: { companyId, provider: "WHATSAPP_CLOUD" },
        select: { id: true },
      })) ??
      (await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label },
        select: { id: true },
      }));

    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: `${label}-pn-${Math.random().toString(36).slice(2, 10)}`,
        displayNumber: "+91 98765 43210",
        status: "CONNECTED",
      },
      select: { id: true },
    });

    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: `${label}_welcome`,
        language: "en_US",
        category: "MARKETING",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello" }],
      },
      select: { id: true },
    });

    return db.leadSource.create({
      data: {
        companyId,
        name: `${label} sheet`,
        spreadsheetId: `${label}-sheet`,
        tab: "Leads",
        actionConfig: { kind: "TEMPLATE", templateId: template.id, mapping: {} },
        templateId: template.id,
        whatsappNumberId: number.id,
      },
      select: { id: true, webhookKey: true },
    });
  });
}

describe("resolving a lead source by its key", () => {
  it("returns the company that owns the binding", async () => {
    const binding = await seedBinding(alpha, "alpha");

    expect(await resolveCompany("lead_source", binding.webhookKey)).toBe(alpha.id);
  });

  it("never returns another company", async () => {
    const mine = await seedBinding(alpha, "alpha");
    const theirs = await seedBinding(beta, "beta");

    expect(await resolveCompany("lead_source", mine.webhookKey)).not.toBe(beta.id);
    expect(await resolveCompany("lead_source", theirs.webhookKey)).toBe(beta.id);
  });

  it("returns nothing for a key nobody holds", async () => {
    await seedBinding(alpha, "alpha");

    expect(await resolveCompany("lead_source", "not-a-real-key")).toBeNull();
  });

  it("returns nothing for an empty key", async () => {
    /* An empty path segment must not match a row with an empty column, and
       must not be sent to the database at all. */
    expect(await resolveCompany("lead_source", "")).toBeNull();
  });

  it("gives each binding its own key", async () => {
    /*
     * Per binding rather than per integration, which is what makes deleting one
     * binding revoke exactly its own script. Sharing the integration's key would
     * mean one pasted script is a credential for every binding a tenant has -
     * and rotating it would silently break the WhatsApp webhook, which is the
     * same column.
     */
    const first = await seedBinding(alpha, "alpha-one");
    const second = await seedBinding(alpha, "alpha-two");

    expect(first.webhookKey).not.toBe(second.webhookKey);
  });

  it("issues a key that is not guessable from the row's id", async () => {
    /* A cuid is time-ordered. Anybody holding one binding's URL could walk to
       its neighbours' if the key were derived from the id. */
    const binding = await seedBinding(alpha, "alpha");

    expect(binding.webhookKey).toMatch(/^[0-9a-f]{32}$/);
    expect(binding.webhookKey).not.toContain(binding.id);
  });

  it("refuses a suspended workspace", async () => {
    /*
     * The opposite of the 'webhook' kind, deliberately. That one resolves for a
     * suspended company because Meta disables a subscription that keeps failing
     * and the tenant would lose every message sent while suspended - evidence,
     * which suspension should not discard.
     *
     * This bell only ever causes us to SEND, and a suspended workspace must not
     * send. Apps Script has no subscription to lose: it rings again the moment
     * the sheet is next edited.
     */
    const binding = await seedBinding(alpha, "alpha");

    await withCompany(alpha.id, (db) =>
      db.company.updateMany({
        where: { id: alpha.id },
        data: { deactivatedAt: new Date() },
      }),
    );

    expect(await resolveCompany("lead_source", binding.webhookKey)).toBeNull();
  });

  it("does not resolve a lead-source key through the WhatsApp webhook kind", async () => {
    /* The two keyspaces must not be interchangeable: a lead-source key that
       resolved as a webhook would open the right company and then fail hunting
       for WhatsApp credentials, at the least debuggable point in the system. */
    const binding = await seedBinding(alpha, "alpha");

    expect(await resolveCompany("webhook", binding.webhookKey)).toBeNull();
  });

  it("does not resolve an integration key through the lead-source kind", async () => {
    await seedBinding(alpha, "alpha");

    const integration = await withCompany(alpha.id, (db, companyId) =>
      db.integration.findFirst({ where: { companyId }, select: { webhookKey: true } }),
    );

    expect(integration?.webhookKey).toBeTruthy();
    expect(
      await resolveCompany("lead_source", integration!.webhookKey),
    ).toBeNull();
  });
});
