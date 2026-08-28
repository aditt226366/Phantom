import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppTemplate,
  listWhatsAppTemplates,
} from "../src/whatsapp/template-graph.ts";
import type { TemplateComponent } from "../src/whatsapp/template.ts";

const SECRETS = {
  WHATSAPP_BUSINESS_ACCOUNT_ID: "204857610394827",
  WHATSAPP_ACCESS_TOKEN: "EAAtoken",
  WHATSAPP_PHONE_NUMBER_ID: "109384756201847",
};

/*
 * Every component kind, deliberately.
 *
 * An earlier version of this fixture was a lone BODY, and the pass-through
 * assertion below was therefore vacuous - break-once proved it by deleting
 * every FOOTER on the way to the wire and watching the suite stay green. A
 * fixture that cannot lose anything cannot detect anything being lost.
 */
const COMPONENTS: TemplateComponent[] = [
  { type: "HEADER", format: "TEXT", text: "Your order" },
  { type: "BODY", text: "Hi {{1}}, your order shipped.", example: { body_text: [["Anita"]] } },
  { type: "FOOTER", text: "Reply STOP to opt out" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Track it" },
      { type: "URL", text: "Shop", url: "https://example.com" },
    ],
  },
];

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("createWhatsAppTemplate", () => {
  it("posts to the WABA, not the phone number", async () => {
    const fetchImpl = respond(200, { id: "1234", status: "PENDING" });
    await createWhatsAppTemplate(
      SECRETS,
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      fetchImpl,
    );

    const [url] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string];
    expect(url).toContain("/204857610394827/message_templates");
    expect(url).not.toContain("109384756201847");
  });

  /*
   * Decision 10 at the wire. The components array is passed through untouched -
   * re-deriving it here would be the second assembly the whole arrangement
   * exists to forbid, and it would be invisible until a customer read it.
   */
  it("sends the components array exactly as given", async () => {
    const fetchImpl = respond(200, { id: "1234" });
    await createWhatsAppTemplate(
      SECRETS,
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      fetchImpl,
    );

    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).components).toEqual(COMPONENTS);
  });

  /*
   * Meta auto-approves some templates on the spot. Hardcoding PENDING would
   * leave the row waiting for a callback that already happened.
   */
  it("takes the status from Meta rather than assuming PENDING", async () => {
    const fetchImpl = respond(200, { id: "1234", status: "APPROVED" });
    const outcome = await createWhatsAppTemplate(
      SECRETS,
      { name: "otp", language: "en_US", category: "AUTHENTICATION", components: COMPONENTS },
      fetchImpl,
    );

    expect(outcome).toMatchObject({ ok: true, status: "APPROVED" });
  });

  /*
   * Meta reads the wording and files the template where IT thinks it belongs,
   * and the price follows the category. Storing what was asked for rather than
   * what came back would understate the bill.
   */
  it("keeps the category Meta chose, not the one requested", async () => {
    const fetchImpl = respond(200, { id: "1234", category: "MARKETING" });
    const outcome = await createWhatsAppTemplate(
      SECRETS,
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      fetchImpl,
    );

    expect(outcome).toMatchObject({ ok: true, category: "MARKETING" });
  });

  it("refuses without a business account id, and calls it config", async () => {
    const fetchImpl = respond(200, { id: "1234" });
    const outcome = await createWhatsAppTemplate(
      { WHATSAPP_ACCESS_TOKEN: "EAAtoken" },
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      fetchImpl,
    );

    expect(outcome).toMatchObject({ ok: false, kind: "config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries Meta's own words and code through", async () => {
    const fetchImpl = respond(400, {
      error: {
        message: "Template name already exists",
        code: 100,
        error_subcode: 2388023,
        fbtrace_id: "Atrace",
      },
    });

    const outcome = await createWhatsAppTemplate(
      SECRETS,
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      fetchImpl,
    );

    expect(outcome).toMatchObject({ ok: false, code: 100 });
    expect(outcome.ok === false && outcome.error).toContain("already exists");
  });

  /*
   * A 200 with no id. Storing that row would leave a template no status
   * callback could ever match - and `transient`, not `config`, because Meta
   * answering oddly is not evidence the tenant's credential is broken.
   */
  it("refuses a 200 that carries no id, without demoting the credential", async () => {
    const outcome = await createWhatsAppTemplate(
      SECRETS,
      { name: "order_update", language: "en_US", category: "UTILITY", components: COMPONENTS },
      respond(200, { status: "PENDING" }),
    );

    expect(outcome).toMatchObject({ ok: false, kind: "transient" });
  });
});

describe("listWhatsAppTemplates", () => {
  it("reads what Meta holds", async () => {
    const outcome = await listWhatsAppTemplates(
      SECRETS,
      respond(200, {
        data: [
          {
            id: "1",
            name: "order_update",
            language: "en_US",
            category: "UTILITY",
            status: "APPROVED",
            components: COMPONENTS,
            rejected_reason: "NONE",
          },
        ],
      }),
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok === true && outcome.templates[0]).toMatchObject({
      name: "order_update",
      status: "APPROVED",
      /* NONE is Meta's way of saying there is no rejection. Callers should not
         have to know that a rejection reason of "NONE" means none. */
      rejectedReason: null,
    });
  });

  it("keeps a real rejection reason", async () => {
    const outcome = await listWhatsAppTemplates(
      SECRETS,
      respond(200, {
        data: [
          {
            id: "2",
            name: "promo",
            language: "en_US",
            status: "REJECTED",
            rejected_reason: "ABUSIVE_CONTENT",
          },
        ],
      }),
    );

    expect(outcome.ok === true && outcome.templates[0]?.rejectedReason).toBe(
      "ABUSIVE_CONTENT",
    );
  });

  it("skips a row with no name or language rather than inventing a key", async () => {
    const outcome = await listWhatsAppTemplates(
      SECRETS,
      respond(200, { data: [{ id: "3", status: "APPROVED" }] }),
    );

    expect(outcome.ok === true && outcome.templates).toEqual([]);
  });
});
