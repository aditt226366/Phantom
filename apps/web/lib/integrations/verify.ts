import "server-only";
import {
  demotesStatus,
  usageDedupeKey,
  verifierFor,
  type FetchImpl,
  type IntegrationProviderName,
  type VerificationOutcome,
} from "@whatsapp-os/core";
import type { Prisma } from "@whatsapp-os/db";
import {
  loadSealedSecrets,
  recordAdminUsage,
  recordVerification,
} from "@/lib/admin-db";
import { open } from "./seal";

/**
 * Check one integration against the real provider.
 *
 * ---------------------------------------------------------------------------
 * The shape of this function is the point
 * ---------------------------------------------------------------------------
 *
 *   1. read the ciphertexts        - one query, which then closes
 *   2. decrypt and call            - no transaction open, network involved
 *   3. write the result            - a second, short transaction
 *
 * A provider call inside a transaction holds a pooled connection for as long
 * as somebody else's API takes to answer. Prisma times out after five seconds
 * and Meta does not care; the same rule already applies to HIBP and to argon2,
 * and it applies here for the same reason.
 *
 * Decryption sits in step 2 deliberately. It is the only place a credential
 * exists in plaintext, it lasts for one function call, and nothing between
 * here and the provider writes it down.
 */

/** Intersection, not extends: VerificationOutcome is a discriminated union. */
export type VerifyResult = VerificationOutcome & { integrationId: string };

export async function verifyIntegration(
  companyId: string,
  provider: IntegrationProviderName,
  options: { fetchImpl?: FetchImpl; dedupeSuffix?: string } = {},
): Promise<VerifyResult | null> {
  /* 1. Read. */
  const loaded = await loadSealedSecrets(companyId, provider);
  if (!loaded) return null;

  /* 2. Decrypt and call. Nothing is open. */
  const secrets: Record<string, string> = {};
  for (const row of loaded.secrets) {
    try {
      secrets[row.key] = open(
        companyId,
        loaded.integrationId,
        row.key,
        row.ciphertext,
      );
    } catch {
      /*
       * A secret that will not open is a real fault — a dropped key, or a row
       * that was moved between companies — and it must not be reported as the
       * provider refusing the credential. Config, so the badge moves and
       * somebody looks, but with a message that says what actually happened.
       */
      const failure: VerifyResult = {
        integrationId: loaded.integrationId,
        ok: false,
        kind: "config",
        error: `Stored credential "${row.key}" could not be decrypted. Re-enter it, or check that the encryption key that sealed it is still present.`,
      };

      await persist(companyId, failure, options.dedupeSuffix);
      return failure;
    }
  }

  const outcome = await verifierFor(provider)(secrets, options.fetchImpl);

  /* 3. Write. */
  const result: VerifyResult = { ...outcome, integrationId: loaded.integrationId };
  await persist(companyId, result, options.dedupeSuffix);

  return result;
}

async function persist(
  companyId: string,
  result: VerifyResult,
  dedupeSuffix: string | undefined,
): Promise<void> {
  await recordVerification(
    companyId,
    result.integrationId,
    result.ok
      ? { ok: true, statusCode: result.statusCode, demote: false }
      : {
          ok: false,
          statusCode: result.statusCode,
          error: result.error,
          failureKind: result.kind,
          details: result.details as Prisma.InputJsonValue | undefined,
          /* A transient failure records itself and leaves the badge alone. */
          demote: demotesStatus(result.kind),
        },
  );

  /*
   * One event per check, keyed so a retry of the same check does not charge
   * twice. Without a suffix the caller is a person pressing a button, and each
   * press is genuinely a separate call.
   */
  await recordAdminUsage(
    companyId,
    "integration.verify",
    usageDedupeKey(
      "integration.verify",
      result.integrationId,
      dedupeSuffix ?? `${Date.now()}`,
    ),
  );
}
