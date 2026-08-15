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

export const INTEGRATION_KEYS = {
  GOOGLE_SHEETS: [
    "GOOGLE_SHEETS_ID",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PRIVATE_KEY",
  ],
  WHATSAPP_CLOUD: [
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_VERIFY_TOKEN",
  ],
  META_ADS: ["META_ADS_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
} as const satisfies Record<IntegrationProviderName, readonly string[]>;

/** Every credential name the system knows about, across all providers. */
export const ALL_INTEGRATION_KEYS: readonly string[] = Object.values(
  INTEGRATION_KEYS,
).flat();

/** Human labels for the console. Kept beside the keys so they cannot drift. */
export const INTEGRATION_LABELS = {
  GOOGLE_SHEETS: "Google Sheets",
  WHATSAPP_CLOUD: "WhatsApp Cloud",
  META_ADS: "Meta Ads",
} as const satisfies Record<IntegrationProviderName, string>;
