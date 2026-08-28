/**
 * One template shape, for the preview and the submission both.
 *
 * ---------------------------------------------------------------------------
 * Decision 10, and the reason this file is in the client-safe barrel
 * ---------------------------------------------------------------------------
 *
 * `buildComponents` produces the array that is POSTed to Meta AND the array the
 * Studio's preview renders from. There is deliberately no second function that
 * assembles "what it will look like" — the preview reads the submission.
 *
 * The alternative is two assemblies of one thing, and they drift. Not
 * hypothetically: a preview that forgets a footer, or orders buttons
 * differently, or substitutes a variable the submission leaves raw, is a screen
 * somebody approved that does not describe the message their customer receives.
 * By the time that is noticed the template is approved and in use.
 *
 * So this module imports nothing. No node:crypto, no fetch, no database — it is
 * reachable from a "use client" component, which is what makes one source
 * possible at all. The core barrel dragged @node-rs/argon2 into a browser
 * bundle for six commits before a page rendered and the build noticed; that is
 * the failure this arrangement avoids.
 */

/* -------------------------------------------------------------------------- *
 * Meta's limits
 * -------------------------------------------------------------------------- */

/** Meta's caps, and what the Studio's live counters count against. */
export const TEMPLATE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  /** Quick replies, per template. A template is quick-reply OR call-to-action. */
  quickReplies: 3,
  /** Call-to-action buttons: at most one URL and one phone number. */
  callToAction: 2,
} as const;

/* -------------------------------------------------------------------------- *
 * Categories
 * -------------------------------------------------------------------------- */

export const TEMPLATE_CATEGORIES = [
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * What each category means and what it costs, in plain English.
 *
 * The price note is not decoration. Meta prices these differently, and a tenant
 * choosing MARKETING for an order update pays more for every send, forever,
 * without anything telling them. The re-categorisation note matters for the
 * same reason from the other direction: Meta reads the wording and moves the
 * template itself, so a UTILITY template written like an advert becomes a
 * MARKETING one — and the bill changes without the tenant touching anything.
 */
export const CATEGORY_NOTES: Record<TemplateCategory, string> = {
  MARKETING:
    "Offers, invitations, anything promotional. The most expensive category — Meta charges more per message.",
  UTILITY:
    "Order updates, receipts, appointment reminders. Cheaper than marketing, but only for messages a customer is expecting.",
  AUTHENTICATION:
    "One-time passcodes only. Priced separately again, and Meta rejects anything that is not a passcode.",
};

/** The warning that belongs beside the category control, whatever is chosen. */
export const CATEGORY_RECATEGORISATION_NOTE =
  "Meta reads the wording, not the label. A utility template written like an advert gets re-categorised as marketing, and the price changes with it.";

/* -------------------------------------------------------------------------- *
 * The component shape — Meta's, not ours
 * -------------------------------------------------------------------------- */

export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";

export type TemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string };

export type TemplateComponent =
  | { type: "HEADER"; format: "TEXT"; text: string }
  | { type: "HEADER"; format: "IMAGE" | "DOCUMENT" | "VIDEO" }
  | { type: "BODY"; text: string; example?: { body_text: string[][] } }
  | { type: "FOOTER"; text: string }
  | { type: "BUTTONS"; buttons: TemplateButton[] };

/**
 * What the builder holds. Flat and editable; `buildComponents` is the only
 * thing that turns it into Meta's shape.
 */
export interface TemplateDraft {
  name: string;
  language: string;
  category: TemplateCategory;
  headerFormat: HeaderFormat;
  headerText: string;
  body: string;
  footer: string;
  buttonKind: "NONE" | "QUICK_REPLY" | "CALL_TO_ACTION";
  quickReplies: string[];
  urlButton: { text: string; url: string } | null;
  phoneButton: { text: string; phone: string } | null;
  /** One sample per {{n}}, indexed from zero. Meta requires these. */
  samples: string[];
}

export function emptyDraft(): TemplateDraft {
  return {
    name: "",
    language: "en_US",
    category: "UTILITY",
    headerFormat: "NONE",
    headerText: "",
    body: "",
    footer: "",
    buttonKind: "NONE",
    quickReplies: [],
    urlButton: null,
    phoneButton: null,
    samples: [],
  };
}

/* -------------------------------------------------------------------------- *
 * The one assembly
 * -------------------------------------------------------------------------- */

/**
 * The submission. Also the preview's input. See the note at the top.
 *
 * Empty parts are omitted rather than sent blank: Meta rejects a FOOTER
 * component with an empty string, and a preview built from the same array then
 * shows an empty line where the tenant expects nothing.
 */
export function buildComponents(draft: TemplateDraft): TemplateComponent[] {
  const components: TemplateComponent[] = [];

  if (draft.headerFormat === "TEXT" && draft.headerText.trim().length > 0) {
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: draft.headerText.trim(),
    });
  } else if (
    draft.headerFormat === "IMAGE" ||
    draft.headerFormat === "DOCUMENT" ||
    draft.headerFormat === "VIDEO"
  ) {
    components.push({ type: "HEADER", format: draft.headerFormat });
  }

  const body: TemplateComponent = { type: "BODY", text: draft.body };

  /*
   * Meta wants one example row per variable, nested one level: body_text is an
   * array of rows, and there is exactly one row. Sent only when the body
   * actually has variables — an example block for a body with none is rejected.
   */
  const variables = templateVariables(draft.body);
  if (variables.length > 0) {
    body.example = { body_text: [variables.map((n) => draft.samples[n - 1] ?? "")] };
  }
  components.push(body);

  if (draft.footer.trim().length > 0) {
    components.push({ type: "FOOTER", text: draft.footer.trim() });
  }

  const buttons = buildButtons(draft);
  if (buttons.length > 0) components.push({ type: "BUTTONS", buttons });

  return components;
}

function buildButtons(draft: TemplateDraft): TemplateButton[] {
  if (draft.buttonKind === "QUICK_REPLY") {
    return draft.quickReplies
      .filter((text) => text.trim().length > 0)
      .slice(0, TEMPLATE_LIMITS.quickReplies)
      .map((text) => ({ type: "QUICK_REPLY", text: text.trim() }));
  }

  if (draft.buttonKind === "CALL_TO_ACTION") {
    const out: TemplateButton[] = [];
    if (draft.urlButton && draft.urlButton.text.trim() && draft.urlButton.url.trim()) {
      out.push({
        type: "URL",
        text: draft.urlButton.text.trim(),
        url: draft.urlButton.url.trim(),
      });
    }
    if (draft.phoneButton && draft.phoneButton.text.trim() && draft.phoneButton.phone.trim()) {
      out.push({
        type: "PHONE_NUMBER",
        text: draft.phoneButton.text.trim(),
        phone_number: draft.phoneButton.phone.trim(),
      });
    }
    return out;
  }

  return [];
}

/* -------------------------------------------------------------------------- *
 * Variables
 * -------------------------------------------------------------------------- */

const VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;

/** Every {{n}} in the text, in the order Meta will read them, deduplicated. */
export function templateVariables(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(VARIABLE)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Substitute samples for {{n}}. Used by the preview, never by the submission. */
export function fillVariables(text: string, samples: string[]): string {
  return text.replace(VARIABLE, (whole, digits: string) => {
    const value = samples[Number(digits) - 1];
    return value && value.length > 0 ? value : whole;
  });
}

/* -------------------------------------------------------------------------- *
 * The name
 * -------------------------------------------------------------------------- */

/**
 * Meta accepts lowercase letters, digits and underscores, and nothing else.
 *
 * Slugified rather than validated-and-refused: a tenant typing "Order Update"
 * means `order_update`, and making them retype it teaches nothing. The field
 * shows the result so what is submitted is never a surprise.
 */
export function slugifyTemplateName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

export interface TemplateIssue {
  /** Which control to attach it to. */
  field: "name" | "language" | "category" | "header" | "body" | "footer" | "buttons" | "samples";
  message: string;
}

/**
 * Everything that can be known without asking Meta.
 *
 * Uniqueness is not here: it is a database question, checked at submit. This
 * runs on every keystroke in the Studio and on the server before the POST, and
 * both get the same answers because it is the same function.
 */
export function validateTemplate(draft: TemplateDraft): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  if (draft.name.length === 0) {
    issues.push({ field: "name", message: "Give the template a name." });
  } else if (draft.name !== slugifyTemplateName(draft.name)) {
    issues.push({
      field: "name",
      message: "Only lowercase letters, digits and underscores.",
    });
  }

  if (draft.language.trim().length === 0) {
    issues.push({ field: "language", message: "Choose a language." });
  }

  if (draft.headerFormat === "TEXT" && draft.headerText.length > TEMPLATE_LIMITS.header) {
    issues.push({
      field: "header",
      message: `Headers are limited to ${TEMPLATE_LIMITS.header} characters.`,
    });
  }

  const body = draft.body.trim();
  if (body.length === 0) {
    issues.push({ field: "body", message: "The body cannot be empty." });
  }
  if (draft.body.length > TEMPLATE_LIMITS.body) {
    issues.push({
      field: "body",
      message: `The body is limited to ${TEMPLATE_LIMITS.body} characters.`,
    });
  }

  if (draft.footer.length > TEMPLATE_LIMITS.footer) {
    issues.push({
      field: "footer",
      message: `Footers are limited to ${TEMPLATE_LIMITS.footer} characters.`,
    });
  }

  issues.push(...validateVariables(draft));
  issues.push(...validateButtons(draft));

  return issues;
}

/**
 * Meta's three rules about variables, each of which is a rejection otherwise.
 *
 * Sequential from 1 with no gaps, because Meta maps them positionally and
 * {{1}},{{3}} has nothing to put in the middle. Never touching the start or end
 * of the body, because a message that opens or closes with a substituted value
 * is indistinguishable from spam to their classifier. And every variable
 * sampled, because the sample is what a human reviewer reads.
 */
function validateVariables(draft: TemplateDraft): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const variables = templateVariables(draft.body);
  if (variables.length === 0) return issues;

  const expected = variables.map((_, index) => index + 1);
  if (variables.join(",") !== expected.join(",")) {
    issues.push({
      field: "body",
      message: `Variables must run 1 to ${variables.length} with no gaps. This has ${variables.map((n) => `{{${n}}}`).join(", ")}.`,
    });
  }

  const trimmed = draft.body.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed)) {
    issues.push({
      field: "body",
      message: "The body cannot start with a variable — Meta rejects it.",
    });
  }
  if (/\{\{\s*\d+\s*\}\}$/.test(trimmed)) {
    issues.push({
      field: "body",
      message: "The body cannot end with a variable — Meta rejects it.",
    });
  }

  const unsampled = variables.filter(
    (n) => !draft.samples[n - 1] || draft.samples[n - 1]?.trim().length === 0,
  );
  if (unsampled.length > 0) {
    issues.push({
      field: "samples",
      message: `Give an example value for ${unsampled.map((n) => `{{${n}}}`).join(", ")}.`,
    });
  }

  return issues;
}

function validateButtons(draft: TemplateDraft): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  if (draft.buttonKind === "QUICK_REPLY") {
    const filled = draft.quickReplies.filter((t) => t.trim().length > 0);
    if (filled.length === 0) {
      issues.push({ field: "buttons", message: "Add a quick reply, or choose none." });
    }
    if (filled.length > TEMPLATE_LIMITS.quickReplies) {
      issues.push({
        field: "buttons",
        message: `At most ${TEMPLATE_LIMITS.quickReplies} quick replies.`,
      });
    }
  }

  if (draft.buttonKind === "CALL_TO_ACTION") {
    const hasUrl = Boolean(draft.urlButton?.text.trim() && draft.urlButton?.url.trim());
    const hasPhone = Boolean(
      draft.phoneButton?.text.trim() && draft.phoneButton?.phone.trim(),
    );

    if (!hasUrl && !hasPhone) {
      issues.push({
        field: "buttons",
        message: "Add a link or a phone number, or choose none.",
      });
    }

    if (draft.urlButton?.url.trim() && !/^https?:\/\//i.test(draft.urlButton.url.trim())) {
      issues.push({ field: "buttons", message: "The link must start with https://." });
    }

    if (draft.phoneButton?.phone.trim() && !/^\+[1-9]\d{6,14}$/.test(draft.phoneButton.phone.trim())) {
      issues.push({
        field: "buttons",
        message: "The phone number must be in full international form, like +919812345670.",
      });
    }
  }

  return issues;
}
