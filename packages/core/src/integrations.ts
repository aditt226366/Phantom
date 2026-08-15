import { z } from "zod";

/**
 * What each provider needs, declared once.
 *
 * This is the list the credential form renders, the vault stores, the adapters
 * read, and the redactor refuses to print. One declaration, so a key cannot be
 * added to the form without the redactor learning about it — the failure mode
 * otherwise is a new credential that logs itself in plaintext for a release.
 *
 * The names are the providers' own, verbatim, because they are what appears in
 * that provider's documentation and in the error messages it returns. A tidier
 * internal naming scheme would have to be translated at every boundary, and the
 * translation table is one more place to be wrong at 3am.
 *
 * Renaming one of these is not a string change here. Each value is encrypted
 * with its key name as part of the AAD, so a rename is a decrypt-and-re-encrypt
 * of every affected row — see the IntegrationSecret docblock in schema.prisma.
 */

export const INTEGRATION_PROVIDERS = [
  "GOOGLE_SHEETS",
  "WHATSAPP_CLOUD",
  "META_ADS",
] as const;

export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];

export interface IntegrationField {
  /** The provider's own name for it. Also the AAD component and the form field. */
  key: string;
  /** What the console calls it. */
  label: string;
  /**
   * Whether knowing this value is enough to act as the customer.
   *
   * It governs one thing precisely: whether the value may be echoed back to
   * the browser when a save fails validation. A failed save re-renders the
   * form, and the natural way to keep the user's typing is to return it in the
   * action's state — which is serialised into the HTML. For a token that is a
   * disclosure with extra steps, so secret fields come back empty and ask to
   * be re-entered. An account id is not worth losing someone's typing over.
   *
   * It does not govern storage. Every value is encrypted at rest regardless,
   * because a "non-secret" identifier still says which customer's spreadsheet
   * and which business account this tenant is wired to.
   */
  secret: boolean;
  /** Shown under the label. */
  hint?: string;
}

export const INTEGRATION_FIELDS = {
  GOOGLE_SHEETS: [
    { key: "GOOGLE_SHEETS_ID", label: "Spreadsheet ID", secret: true },
    {
      key: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
      label: "Service account email",
      secret: false,
      hint: "Share the spreadsheet with this address.",
    },
    { key: "GOOGLE_PRIVATE_KEY", label: "Private key", secret: true },
  ],
  WHATSAPP_CLOUD: [
    { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", secret: false },
    {
      key: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      label: "Business account ID",
      secret: false,
    },
    { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", secret: true },
    { key: "WHATSAPP_VERIFY_TOKEN", label: "Verify token", secret: true },
  ],
  META_ADS: [
    { key: "META_ADS_ACCESS_TOKEN", label: "Access token", secret: true },
    { key: "META_AD_ACCOUNT_ID", label: "Ad account ID", secret: true },
  ],
} as const satisfies Record<IntegrationProviderName, readonly IntegrationField[]>;

/** Every credential name the system knows about, across all providers. */
export const ALL_INTEGRATION_KEYS: readonly string[] = Object.values(
  INTEGRATION_FIELDS,
).flatMap((fields) => fields.map((field) => field.key));

/** Human labels for the console. Kept beside the keys so they cannot drift. */
export const INTEGRATION_LABELS = {
  GOOGLE_SHEETS: "Google Sheets",
  WHATSAPP_CLOUD: "WhatsApp Cloud",
  META_ADS: "Meta Ads",
} as const satisfies Record<IntegrationProviderName, string>;

export function integrationFields(
  provider: IntegrationProviderName,
): readonly IntegrationField[] {
  return INTEGRATION_FIELDS[provider];
}

/** Whether a value may be echoed back to the browser. Unknown keys are secret. */
export function isSecretField(key: string): boolean {
  for (const fields of Object.values(INTEGRATION_FIELDS)) {
    for (const field of fields) {
      if (field.key === key) return field.secret;
    }
  }
  /* Fail closed: a key nobody declared is not one to start echoing. */
  return true;
}

/**
 * The additional authenticated data binding a stored secret to its row.
 *
 * One function, used by everything that encrypts or decrypts a credential.
 * This is not a stylistic preference: an AAD assembled slightly differently on
 * the encrypt side than the decrypt side produces a value that nothing can
 * ever open — not the old key, not the new one, not a restore of key material.
 * Two call sites building the same string by hand is exactly how that happens,
 * so there are not two call sites.
 *
 * Changing this format orphans every stored secret. It is not a format to
 * improve.
 */
export function secretAad(
  companyId: string,
  integrationId: string,
  key: string,
): string {
  return `${companyId}:${integrationId}:${key}`;
}

/**
 * The masking rule for a stored credential.
 *
 * Values shorter than this get no last4 at all. Revealing the last four
 * characters of a six-character value discloses most of it, and the point of
 * the hint is to let someone confirm which credential is loaded, not to
 * reconstruct it.
 */
export const MIN_LENGTH_FOR_LAST4 = 12;

export function last4Of(value: string): string | null {
  return value.length >= MIN_LENGTH_FOR_LAST4 ? value.slice(-4) : null;
}

/**
 * The subset of a submission that may be sent back to the browser.
 *
 * A failed save re-renders the form, and the obvious way to keep someone's
 * typing is to return it in the action's state — which React serialises into
 * the HTML of the response. For an access token that is a disclosure dressed
 * as a convenience: it lands in the page source, in the browser's back-forward
 * cache, and in any proxy that logs response bodies, for a credential the
 * panel is otherwise careful never to display.
 *
 * So the values that come back are only the ones no attacker wants. Everything
 * else is re-typed, and the form says so.
 */
export function echoableValues(
  submitted: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(submitted)) {
    if (!isSecretField(key)) out[key] = value;
  }

  return out;
}

/**
 * Shape validation for a save.
 *
 * Every field is optional at this layer: blank means "leave the stored value
 * alone", which is a legitimate submission and not a missing one. What is
 * checked is that anything actually typed is plausible, and that the
 * submission is not entirely empty — a save that changes nothing is a mistake
 * worth reporting rather than a no-op worth pretending succeeded.
 */
export function integrationSaveSchema(
  provider: IntegrationProviderName,
): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodType> = {};

  for (const field of integrationFields(provider)) {
    let rule: z.ZodType<string> = z
      .string()
      .max(8192, `${field.label} is longer than anything a provider issues`);

    if (field.key === "GOOGLE_SERVICE_ACCOUNT_EMAIL") {
      rule = rule.refine(
        (value) => value === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
        "Enter the service account's email address",
      );
    }

    shape[field.key] = rule;
  }

  return z
    .object(shape)
    .refine(
      (values: Record<string, unknown>) =>
        Object.values(values).some(
          (value) => typeof value === "string" && value.trim() !== "",
        ),
      "Fill in at least one field. Blank fields keep their stored value.",
    ) as z.ZodType<Record<string, string>>;
}
