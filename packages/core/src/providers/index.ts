import type { IntegrationProviderName } from "../integrations.ts";
import { verifyGoogleSheets } from "./google-sheets.ts";
import { verifyMetaAds, verifyWhatsAppCloud } from "./meta.ts";
import type { FetchImpl, VerificationOutcome } from "./types.ts";

export * from "./types.ts";
export {
  cachedAccessToken,
  checkSheetAccess,
  clearAccessTokenCache,
  exchangeAccessToken,
  isQuotaFailure,
  listSheetTabs,
  normalisePrivateKey,
  readSheetValues,
  retryAfterMs,
  signServiceAccountJwt,
  verifyGoogleSheets,
} from "./google-sheets.ts";
export type {
  AccessTokenOutcome,
  GoogleAccessToken,
  SheetTab,
  TabsOutcome,
  ValuesOutcome,
} from "./google-sheets.ts";
export {
  decodeGraphFailure,
  graphGetJson,
  graphGetQuery,
  graphPost,
  verifyMetaAds,
  verifyWhatsAppCloud,
} from "./meta.ts";
export type { GraphResult } from "./meta.ts";
export {
  campaignInsights,
  createPausedCampaign,
  listAdAccounts,
  listPages,
  minorUnitsFromMicros,
  pageWhatsAppLink,
  setCampaignStatus,
  spendToMicros,
} from "./meta-ads.ts";
export type {
  CreateCampaignInput,
  DailyCampaignSpend,
  MetaAdAccountSummary,
  MetaCampaignObjectiveName,
  MetaPageSummary,
  PageWhatsAppLink,
} from "./meta-ads.ts";
export {
  TOKEN_EXPIRY_WARNING_DAYS,
  debugToken,
  expiryDemotesStatus,
  tokenExpiryState,
} from "./token.ts";
export type { TokenExpiryState } from "./token.ts";

export type ProviderVerifier = (
  secrets: Readonly<Record<string, string>>,
  fetchImpl?: FetchImpl,
) => Promise<VerificationOutcome>;

/**
 * One verifier per provider, looked up by name.
 *
 * `satisfies` rather than a plain annotation, so adding a provider to
 * INTEGRATION_PROVIDERS without a verifier is a compile error rather than an
 * integration that silently reports nothing.
 */
export const PROVIDER_VERIFIERS = {
  GOOGLE_SHEETS: verifyGoogleSheets,
  WHATSAPP_CLOUD: verifyWhatsAppCloud,
  META_ADS: verifyMetaAds,
} as const satisfies Record<IntegrationProviderName, ProviderVerifier>;

export function verifierFor(
  provider: IntegrationProviderName,
): ProviderVerifier {
  return PROVIDER_VERIFIERS[provider];
}
