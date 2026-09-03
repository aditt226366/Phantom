import "server-only";
import { metaAdsCredentials, withCompany } from "@whatsapp-os/db";
import { open } from "@/lib/integrations/seal";

/**
 * The tenant's own Meta Ads credentials, opened.
 *
 * Two properties, and they are the reason this is a function rather than four
 * lines at each call site.
 *
 * The read happens inside withCompany and the DECRYPTION happens outside it.
 * A withCompany scope is a transaction holding a pooled connection with a
 * five-second budget, and everything a caller does with these values is a
 * Graph call - the conventions are explicit that HTTP stays out. Opening
 * inside would put CPU work there too, for no reason.
 *
 * And the company id comes from the caller, which took it from a session.
 * Never from a request: withCompany sets the value RLS trusts, so a company id
 * off a search param would be a total bypass. Rule 3.
 */
export interface MetaAdsCredentials {
  integrationId: string;
  accessToken: string;
  /** The account id the admin panel stored, if one was stored. */
  configuredAdAccountId: string | null;
}

/**
 * Null when there is no usable credential, and the caller renders the connect
 * prompt rather than an error.
 *
 * The three ways to get null are deliberately not distinguished here: no
 * integration row, no token, or a token that will not open. The screen says the
 * same thing for all three - a platform operator has to store the credentials -
 * and inventing three messages would be inventing three things a tenant could
 * do about it, when the answer is one.
 */
export async function loadMetaAdsCredentials(
  companyId: string,
): Promise<MetaAdsCredentials | null> {
  const sealed = await withCompany(companyId, (db, scopedCompanyId) =>
    metaAdsCredentials(db, scopedCompanyId),
  );

  if (!sealed) return null;

  const token = sealed.secrets.find((row) => row.key === "META_ADS_ACCESS_TOKEN");
  if (!token) return null;

  const account = sealed.secrets.find((row) => row.key === "META_AD_ACCOUNT_ID");

  try {
    return {
      integrationId: sealed.integrationId,
      accessToken: open(
        companyId,
        sealed.integrationId,
        token.key,
        token.ciphertext,
      ),
      configuredAdAccountId: account
        ? open(companyId, sealed.integrationId, account.key, account.ciphertext)
        : null,
    };
  } catch {
    /*
     * A ciphertext that will not open is a real state - a keyring rotated
     * without a re-encrypt, a row moved between companies - and it is one the
     * vault's own status page reports. Here it is simply "no usable
     * credential": this screen cannot fix it and must not print the reason,
     * because the reason is about our key material rather than the tenant's.
     */
    return null;
  }
}
