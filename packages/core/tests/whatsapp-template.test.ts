import { describe, expect, it } from "vitest";
import {
  buildComponents,
  draftFromComponents,
  emptyDraft,
  fillVariables,
  slugifyTemplateName,
  TEMPLATE_LIMITS,
  templateVariables,
  validateTemplate,
  type TemplateDraft,
} from "../src/whatsapp/template.ts";

/** A draft that passes validation, so each test can break exactly one thing. */
function valid(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    ...emptyDraft(),
    name: "order_update",
    body: "Hi {{1}}, your order {{2}} has shipped.",
    samples: ["Anita", "NW-2291"],
    ...overrides,
  };
}

function fieldsOf(draft: TemplateDraft): string[] {
  return validateTemplate(draft).map((issue) => issue.field);
}

describe("buildComponents", () => {
  it("omits empty parts rather than sending them blank", () => {
    /* Meta rejects a FOOTER with an empty string, and a preview reading the
       same array would render a blank line where the tenant expects nothing. */
    const components = buildComponents(valid());
    expect(components.map((c) => c.type)).toEqual(["BODY"]);
  });

  it("puts the components in Meta's order", () => {
    const components = buildComponents(
      valid({
        headerFormat: "TEXT",
        headerText: "Your order",
        footer: "Reply STOP to opt out",
        buttonKind: "QUICK_REPLY",
        quickReplies: ["Track it", "Talk to us"],
      }),
    );

    expect(components.map((c) => c.type)).toEqual([
      "HEADER",
      "BODY",
      "FOOTER",
      "BUTTONS",
    ]);
  });

  /*
   * Meta wants one example row per variable, nested one level, and only when
   * the body has variables at all — an example block on a body with none is
   * rejected outright.
   */
  it("attaches samples as one nested row", () => {
    const [body] = buildComponents(valid());
    expect(body).toMatchObject({
      type: "BODY",
      example: { body_text: [["Anita", "NW-2291"]] },
    });
  });

  it("sends no example block when the body has no variables", () => {
    const [body] = buildComponents(valid({ body: "We are closed Monday.", samples: [] }));
    expect(body).toEqual({ type: "BODY", text: "We are closed Monday." });
  });

  it("carries no text on a media header — Meta supplies that at send time", () => {
    const components = buildComponents(valid({ headerFormat: "IMAGE" }));
    expect(components[0]).toEqual({ type: "HEADER", format: "IMAGE" });
  });

  it("emits at most three quick replies", () => {
    const components = buildComponents(
      valid({
        buttonKind: "QUICK_REPLY",
        quickReplies: ["a", "b", "c", "d"],
      }),
    );
    const buttons = components.find((c) => c.type === "BUTTONS");
    expect(buttons && "buttons" in buttons ? buttons.buttons : []).toHaveLength(
      TEMPLATE_LIMITS.quickReplies,
    );
  });

  /*
   * Decision 10, asserted rather than described.
   *
   * The preview and the submission are the same array, so the only thing that
   * separates what a tenant sees from what Meta receives is variable
   * substitution — and that is applied TO the submission's own text, not to a
   * parallel string built somewhere else. If a second assembly ever appears,
   * this is the test that should stop it: the rendered preview must be
   * derivable from buildComponents' output alone.
   */
  it("renders a preview from the submitted array and nothing else", () => {
    const draft = valid({ footer: "Reply STOP to opt out" });
    const components = buildComponents(draft);

    const body = components.find((c) => c.type === "BODY");
    const text = body && "text" in body ? body.text : "";

    expect(fillVariables(text, draft.samples)).toBe(
      "Hi Anita, your order NW-2291 has shipped.",
    );
  });
});

describe("templateVariables", () => {
  it("finds them in order and deduplicates", () => {
    expect(templateVariables("{{2}} and {{1}} and {{2}} again")).toEqual([1, 2]);
  });

  it("tolerates the spacing Meta tolerates", () => {
    expect(templateVariables("a {{ 1 }} b")).toEqual([1]);
  });

  it("ignores things that are not variables", () => {
    expect(templateVariables("{{}} {{x}} {{0}}")).toEqual([]);
  });
});

describe("fillVariables", () => {
  it("leaves a variable alone when there is no sample for it", () => {
    /* The preview must not silently blank an unsampled variable — seeing
       {{2}} is what tells somebody the sample is missing. */
    expect(fillVariables("Hi {{1}}, order {{2}}", ["Anita"])).toBe(
      "Hi Anita, order {{2}}",
    );
  });
});

describe("slugifyTemplateName", () => {
  it("turns what somebody types into what Meta accepts", () => {
    expect(slugifyTemplateName("Order Update!")).toBe("order_update");
    expect(slugifyTemplateName("  spaced  out  ")).toBe("spaced_out");
    expect(slugifyTemplateName("already_fine")).toBe("already_fine");
  });

  it("is idempotent", () => {
    const once = slugifyTemplateName("Order Update!");
    expect(slugifyTemplateName(once)).toBe(once);
  });
});

describe("validateTemplate", () => {
  it("passes a well-formed draft", () => {
    expect(validateTemplate(valid())).toEqual([]);
  });

  /*
   * Meta maps variables positionally, so a gap has nothing to put in the
   * middle and the submission is rejected.
   */
  it("refuses a gap in the numbering", () => {
    const issues = validateTemplate(
      valid({ body: "Hi {{1}}, order {{3}} shipped.", samples: ["a", "b", "c"] }),
    );
    expect(issues.some((i) => /no gaps/i.test(i.message))).toBe(true);
  });

  /*
   * A message that opens or closes on a substituted value is what Meta's
   * classifier reads as spam. Both ends, separately.
   */
  it("refuses a variable at the very start", () => {
    const issues = validateTemplate(valid({ body: "{{1}} your order shipped." }));
    expect(issues.some((i) => /cannot start/i.test(i.message))).toBe(true);
  });

  it("refuses a variable at the very end", () => {
    const issues = validateTemplate(valid({ body: "Your order is {{1}}" }));
    expect(issues.some((i) => /cannot end/i.test(i.message))).toBe(true);
  });

  it("refuses an unsampled variable", () => {
    expect(fieldsOf(valid({ samples: ["Anita"] }))).toContain("samples");
  });

  it("counts against Meta's limits", () => {
    expect(fieldsOf(valid({ body: "x".repeat(TEMPLATE_LIMITS.body + 1) }))).toContain("body");
    expect(
      fieldsOf(valid({ headerFormat: "TEXT", headerText: "x".repeat(61) })),
    ).toContain("header");
    expect(fieldsOf(valid({ footer: "x".repeat(61) }))).toContain("footer");
  });

  it("refuses a name Meta would not accept", () => {
    expect(fieldsOf(valid({ name: "Order Update" }))).toContain("name");
  });

  it("refuses a call-to-action link that is not a URL", () => {
    const issues = validateTemplate(
      valid({
        buttonKind: "CALL_TO_ACTION",
        urlButton: { text: "Shop", url: "example.com" },
      }),
    );
    expect(issues.some((i) => /https/i.test(i.message))).toBe(true);
  });

  it("refuses a phone number that is not international", () => {
    const issues = validateTemplate(
      valid({
        buttonKind: "CALL_TO_ACTION",
        phoneButton: { text: "Call", phone: "9812345670" },
      }),
    );
    expect(issues.some((i) => /international/i.test(i.message))).toBe(true);
  });

  it("refuses a button block with nothing in it", () => {
    expect(fieldsOf(valid({ buttonKind: "QUICK_REPLY", quickReplies: [] }))).toContain(
      "buttons",
    );
    expect(fieldsOf(valid({ buttonKind: "CALL_TO_ACTION" }))).toContain("buttons");
  });
});

describe("draftFromComponents", () => {
  /*
   * The property that matters, and the only one worth asserting.
   *
   * This is the inverse of the one forward path, not a second forward path -
   * decision 10 forbids the latter and says nothing about the former. But the
   * danger it carries is its own: if the inverse loses a field, opening a
   * template and pressing submit without touching anything silently changes it.
   * A footer that did not survive would simply vanish from an approved template
   * on its next edit, and nothing would report it.
   */
  const CASES: Array<[string, TemplateDraft]> = [
    ["body only", valid()],
    [
      "every part",
      valid({
        headerFormat: "TEXT",
        headerText: "Your order",
        footer: "Reply STOP to opt out",
        buttonKind: "QUICK_REPLY",
        quickReplies: ["Track it", "Talk to us"],
      }),
    ],
    ["a media header", valid({ headerFormat: "IMAGE" })],
    [
      "a call to action",
      valid({
        buttonKind: "CALL_TO_ACTION",
        urlButton: { text: "Shop", url: "https://example.com" },
        phoneButton: { text: "Call", phone: "+919812345670" },
      }),
    ],
    ["no variables", valid({ body: "We are closed Monday.", samples: [] })],
  ];

  it.each(CASES)("round-trips %s", (_label, draft) => {
    const components = buildComponents(draft);
    const back = draftFromComponents(components, {
      name: draft.name,
      language: draft.language,
      category: draft.category,
    });

    expect(buildComponents(back)).toEqual(components);
  });

  it("recovers the samples Meta was given", () => {
    const components = buildComponents(valid());
    const back = draftFromComponents(components, {
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
    });

    expect(back.samples).toEqual(["Anita", "NW-2291"]);
  });
});
