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
  /**
   * Whether the integration is unusable without it.
   *
   * Explicit on every field rather than optional, so adding a credential
   * forces the question. Getting it wrong in the lenient direction is how a
   * card ends up reading CONNECTED for an integration that cannot do its job.
   *
   * Requiredness used to live inside each verifier, as a hard-coded check that
   * produced a `config` failure. That is still where the *message* comes from;
   * this is the declaration everything else can read - in particular the badge,
   * which cannot call a verifier to find out whether a value is missing.
   */
  required: boolean;
  /** Shown under the label. */
  hint?: string;
}

export const INTEGRATION_FIELDS = {
  GOOGLE_SHEETS: [
    /* verifyGoogleSheets refuses without all three. */
    { key: "GOOGLE_SHEETS_ID", label: "Spreadsheet ID", secret: true, required: true },
    {
      key: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
      label: "Service account email",
      secret: false,
      required: true,
      hint: "Share the spreadsheet with this address.",
    },
    { key: "GOOGLE_PRIVATE_KEY", label: "Private key", secret: true, required: true },
  ],
  WHATSAPP_CLOUD: [
    {
      key: "WHATSAPP_PHONE_NUMBER_ID",
      label: "Phone number ID",
      secret: false,
      required: true,
    },
    {
      key: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      label: "Business account ID",
      secret: false,
      /*
       * Required as of 4b, and this is the commit that starts needing it.
       *
       * It was optional for exactly as long as nothing read it - a key that
       * holds a badge down while no code path would notice its absence teaches
       * operators to ignore the badge. The Template Studio changed that: every
       * template call is scoped to the WABA, so without this the Studio submits
       * nothing and the Library syncs nothing.
       *
       * The flip and the need land together on purpose. Commit 11's derived
       * effectiveIntegrationStatus already reads `required`, so the badge
       * starts reporting the absence in the same commit that makes it matter,
       * rather than in a later one that would leave a window where the panel
       * says CONNECTED about an integration that cannot do half its job.
       */
      required: true,
    },
    {
      key: "WHATSAPP_ACCESS_TOKEN",
      label: "Access token",
      secret: true,
      required: true,
    },
    {
      key: "WHATSAPP_VERIFY_TOKEN",
      label: "Verify token",
      secret: true,
      /* Echoed back to Meta during the GET subscription handshake. Without it
         the webhook can never be subscribed in the first place. */
      required: true,
    },
    {
      key: "WHATSAPP_APP_SECRET",
      label: "App secret",
      secret: true,
      /*
       * The HMAC key for X-Hub-Signature-256. Without it an inbound delivery
       * cannot be distinguished from a forgery, so the endpoint would have to
       * either accept anything or reject everything.
       *
       * Nothing in verifyWhatsAppCloud touches it - that calls
       * GET /{phone_number_id}, which succeeds perfectly well without an app
       * secret. Which is exactly why requiredness is declared here and read by
       * the badge, rather than left to the verifier to discover.
       */
      required: true,
      hint: "Meta app dashboard, under Settings > Basic.",
    },
  ],
  META_ADS: [
    /* verifyMetaAds refuses without both. */
    { key: "META_ADS_ACCESS_TOKEN", label: "Access token", secret: true, required: true },
    { key: "META_AD_ACCOUNT_ID", label: "Ad account ID", secret: true, required: true },
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

/** The keys an integration cannot work without. */
export function requiredIntegrationKeys(
  provider: IntegrationProviderName,
): readonly string[] {
  return INTEGRATION_FIELDS[provider]
    .filter((field) => field.required)
    .map((field) => field.key);
}

/** Which required keys are absent, in declaration order. */
export function missingRequiredKeys(
  provider: IntegrationProviderName,
  storedKeys: readonly string[],
): readonly string[] {
  const held = new Set(storedKeys);
  return requiredIntegrationKeys(provider).filter((key) => !held.has(key));
}

export type IntegrationStatusName = "CONNECTED" | "NOT_CONNECTED";

/**
 * What the badge should say, as opposed to what the database last recorded.
 *
 * These are not the same question and conflating them is the bug this exists to
 * prevent.
 *
 * The stored status answers "what did the provider say the last time we asked".
 * It is written by a verifier and it is correct: verifyWhatsAppCloud calls
 * GET /{phone_number_id}, that call genuinely succeeds without an app secret,
 * and recording CONNECTED is an honest report of what happened.
 *
 * The badge answers "is this integration going to work", which is a different
 * thing, because a WhatsApp connection with no app secret cannot verify a
 * single inbound delivery. An operator glancing at CONNECTED would stop
 * looking, and the conventions are explicit that the operator acts on the
 * badge.
 *
 * ---------------------------------------------------------------------------
 * Derived, never written
 * ---------------------------------------------------------------------------
 *
 * The alternative was to write NOT_CONNECTED into the column when a required
 * key is missing. That is wrong twice over: it puts a claim in the status
 * column that no provider ever made, and the very next successful verification
 * overwrites it with CONNECTED while the key is still missing. A derived value
 * cannot drift out of agreement with the secrets that produced it.
 *
 * It also needs no third enum member, so IntegrationStatus keeps its "two
 * states, not three" property.
 */
/*
 * A third input as of Phase 10: an expired credential.
 *
 * It belongs here rather than in a check beside the badge, because it is the
 * same question the other two answer - "is this integration going to work" -
 * and the answer is no for exactly the same reason a missing required key is
 * no. A token Meta will refuse is not a connection.
 *
 * It is `auth`-class, in the vocabulary of providers/types.ts, so it demotes.
 * An EXPIRING token does not: see expiryDemotesStatus, which is where that
 * line is drawn and why.
 *
 * Optional so that the two providers with no expiring credential - and every
 * existing caller - are unchanged. Passing nothing means "no expiry recorded",
 * which is the honest state for a Google private key.
 */
export function effectiveIntegrationStatus(
  provider: IntegrationProviderName,
  storedKeys: readonly string[],
  storedStatus: IntegrationStatusName,
  credentialsExpired = false,
): IntegrationStatusName {
  if (missingRequiredKeys(provider, storedKeys).length > 0) return "NOT_CONNECTED";
  if (credentialsExpired) return "NOT_CONNECTED";
  return storedStatus;
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
