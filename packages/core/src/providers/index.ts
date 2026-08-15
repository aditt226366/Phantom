import type { IntegrationProviderName } from "../integrations.ts";
import { verifyGoogleSheets } from "./google-sheets.ts";
import { verifyMetaAds, verifyWhatsAppCloud } from "./meta.ts";
import type { FetchImpl, VerificationOutcome } from "./types.ts";

export * from "./types.ts";
export {
  normalisePrivateKey,
  signServiceAccountJwt,
  verifyGoogleSheets,
} from "./google-sheets.ts";
export {
  decodeGraphFailure,
  verifyMetaAds,
  verifyWhatsAppCloud,
} from "./meta.ts";

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
