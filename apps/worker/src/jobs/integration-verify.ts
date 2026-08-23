import {
  decrypt,
  demotesStatus,
  secretAad,
  usageDedupeKey,
  verifierFor,
  type IntegrationProviderName,
  type IntegrationVerifyJob,
  type VerificationOutcome,
} from "@whatsapp-os/core";
import { recordUsage, withCompany, type Prisma } from "@whatsapp-os/db";
import { JOB_NAMES } from "@whatsapp-os/core";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";
import { systemQueue } from "../queue.ts";

/**
 * Check a company's integrations against the real providers.
 *
 * Same three steps as the web-side path, for the same reason:
 *
 *   1. read the ciphertexts   - one transaction, which then closes
 *   2. decrypt and call       - nothing open, network involved
 *   3. write the result       - a second, short transaction
 *
 * A provider call inside a transaction holds a pooled connection for as long
 * as somebody else's API takes to answer, and Prisma gives up after five
 * seconds while Meta does not care.
 */

interface Loaded {
  id: string;
  provider: IntegrationProviderName;
  secrets: Array<{ key: string; ciphertext: string }>;
}

export async function handleIntegrationVerify(
  payload: IntegrationVerifyJob,
  jobId: string,
): Promise<{ checked: number; ok: number }> {
  const { companyId, integrationId } = payload;

  /* 1. Read. */
  const loaded: Loaded[] = await withCompany(companyId, (db) =>
    db.integration.findMany({
      ...(integrationId ? { where: { id: integrationId } } : {}),
      select: {
        id: true,
        provider: true,
        secrets: { select: { key: true, ciphertext: true } },
      },
    }),
  );

  let ok = 0;

  for (const integration of loaded) {
    const outcome = await checkOne(companyId, integration);
    if (outcome.ok) ok++;

    /* 3. Write, one integration at a time. */
    await withCompany(companyId, async (db, scoped) => {
      await db.integrationVerification.create({
        data: {
          companyId: scoped,
          integrationId: integration.id,
          ok: outcome.ok,
          ...(outcome.statusCode === undefined
            ? {}
            : { statusCode: outcome.statusCode }),
          ...(outcome.ok
            ? {}
            : {
                error: outcome.error,
                failureKind: outcome.kind,
                ...(outcome.details
                  ? { details: outcome.details as Prisma.InputJsonValue }
                  : {}),
              }),
        },
      });

      await db.integration.update({
        where: { id: integration.id },
        data: {
          lastError: outcome.ok ? null : outcome.error,
          ...(outcome.ok
            ? { status: "CONNECTED", lastVerifiedAt: new Date() }
            : demotesStatus(outcome.kind)
              ? { status: "NOT_CONNECTED" }
              : {}),
        },
      });

      /*
       * The job id, not a timestamp. DEFAULT_JOB_OPTIONS retries five times,
       * and every attempt carries the same id — so one provider call is
       * charged once however many attempts it took to record.
       */
      await recordUsage(db, scoped, {
        kind: "integration.verify",
        dedupeKey: usageDedupeKey("integration.verify", jobId, integration.id),
      });
    });
  }

  log.info("integrations verified", {
    companyId,
    checked: loaded.length,
    ok,
  });

  /*
   * A successful verification is the moment a WhatsApp number's metadata is
   * most likely to be missing and the credentials are known good, so it is one
   * of the three things that trigger a refresh - the others being a person
   * pressing Refresh and Meta's phone_number_quality_update webhook.
   *
   * Enqueued after the loop and outside every scope: this is a Redis call, and
   * the refresh is somebody else's job by design. Failing to enqueue must not
   * fail the verification that already succeeded and was already recorded, so
   * it is caught and logged rather than thrown - the next verification, webhook
   * or button press will do it.
   */
  if (ok > 0) {
    try {
      await systemQueue.add(
        JOB_NAMES.WHATSAPP_NUMBERS_REFRESH,
        { companyId },
        { jobId: `numbers:${companyId}:${jobId}` },
      );
    } catch (error) {
      log.warn("could not enqueue a numbers refresh after verification", {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { checked: loaded.length, ok };
}

async function checkOne(
  companyId: string,
  integration: Loaded,
): Promise<VerificationOutcome> {
  /* 2. Decrypt, then call. No transaction is open here. */
  const secrets: Record<string, string> = {};

  for (const row of integration.secrets) {
    try {
      secrets[row.key] = decrypt(
        row.ciphertext,
        keyring(),
        secretAad(companyId, integration.id, row.key),
      );
    } catch {
      /*
       * A dropped key, or a row that was moved. Config rather than auth: the
       * credential is not refused, it cannot be read, and telling an operator
       * to re-enter it would be the wrong instruction.
       */
      return {
        ok: false,
        kind: "config",
        error: `Stored credential "${row.key}" could not be decrypted. Check that the encryption key that sealed it is still present.`,
      };
    }
  }

  return verifierFor(integration.provider)(secrets);
}
