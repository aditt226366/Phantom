import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The submit job's sequence, which is where its safety lives.
 *
 * Two things are asserted rather than assumed. That the stored components go
 * to the wire untouched — decision 10 has no meaning at all if the last step
 * before Meta re-derives them. And that a template Meta has already named is
 * never submitted a second time, because the refusal that produces describes
 * our own bug ("name already exists") rather than anything the tenant did, and
 * it lands in the field they are asked to read and act on.
 */

const findFirst = vi.fn();
/* Typed to the shape the job calls, so the argument assertions below are
   actually checked rather than reaching into an inferred empty tuple - the
   trap whatsapp-send.test.ts names in its own header. */
const updateMany =
  vi.fn<
    (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>
  >();
const createWhatsAppTemplate = vi.fn();

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (_companyId: string, fn: (db: unknown) => unknown) =>
    fn({ whatsAppTemplate: { findFirst, updateMany } }),
}));

vi.mock("@whatsapp-os/core/whatsapp", () => ({ createWhatsAppTemplate }));

vi.mock("@whatsapp-os/core", () => ({
  decrypt: (ciphertext: string) => `plain:${ciphertext}`,
  secretAad: () => "aad",
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));
vi.mock("../src/logger.ts", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { handleWhatsAppTemplateSubmit } = await import(
  "../src/jobs/whatsapp-template-submit.ts"
);

const COMPONENTS = [
  { type: "HEADER", format: "TEXT", text: "Your order" },
  { type: "BODY", text: "Hi {{1}}, it shipped." },
  { type: "FOOTER", text: "Reply STOP to opt out" },
];

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-1",
    name: "order_update",
    language: "en_US",
    category: "UTILITY",
    components: COMPONENTS,
    metaTemplateId: null,
    integrationId: "integration-1",
    integration: { secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }] },
    ...overrides,
  };
}

const JOB = { companyId: "company-1", templateId: "template-1" };

beforeEach(() => {
  findFirst.mockReset();
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
  createWhatsAppTemplate.mockReset();
});

describe("handleWhatsAppTemplateSubmit", () => {
  it("sends the stored components to Meta untouched", async () => {
    findFirst.mockResolvedValue(template());
    createWhatsAppTemplate.mockResolvedValue({
      ok: true,
      metaTemplateId: "meta-9",
      status: "PENDING",
      category: null,
    });

    const outcome = await handleWhatsAppTemplateSubmit(JOB);

    expect(outcome).toEqual({ result: "submitted" });
    expect(createWhatsAppTemplate.mock.calls[0]?.[1]).toMatchObject({
      components: COMPONENTS,
    });
  });

  it("records Meta's id and Meta's status", async () => {
    findFirst.mockResolvedValue(template());
    createWhatsAppTemplate.mockResolvedValue({
      ok: true,
      metaTemplateId: "meta-9",
      /* Meta auto-approves some templates on the spot. */
      status: "APPROVED",
      category: "MARKETING",
    });

    await handleWhatsAppTemplateSubmit(JOB);

    expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      metaTemplateId: "meta-9",
      status: "APPROVED",
      /* Meta re-categorised it, and the price follows the category. */
      category: "MARKETING",
      rejectedReason: null,
    });
  });

  /*
   * The guard that matters. A template Meta has already named is created; a
   * second POST is refused for a duplicate name, and that refusal would be
   * written into rejectedReason - the field the Studio asks a tenant to read
   * and act on. They would be shown our bug and asked to fix their wording.
   */
  it("never submits a template Meta has already named", async () => {
    findFirst.mockResolvedValue(template({ metaTemplateId: "meta-9" }));

    const outcome = await handleWhatsAppTemplateSubmit(JOB);

    expect(outcome).toEqual({ result: "already_submitted" });
    expect(createWhatsAppTemplate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("stores Meta's refusal verbatim", async () => {
    findFirst.mockResolvedValue(template());
    createWhatsAppTemplate.mockResolvedValue({
      ok: false,
      kind: "config",
      error: "Template name is invalid",
      statusCode: 400,
      code: 100,
    });

    const outcome = await handleWhatsAppTemplateSubmit(JOB);

    expect(outcome).toEqual({ result: "refused" });
    expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "REJECTED",
      rejectedReason: "Template name is invalid",
    });
  });

  it("reports a template that is not there rather than throwing", async () => {
    findFirst.mockResolvedValue(null);

    expect(await handleWhatsAppTemplateSubmit(JOB)).toEqual({
      result: "unknown_template",
    });
    expect(createWhatsAppTemplate).not.toHaveBeenCalled();
  });
});
