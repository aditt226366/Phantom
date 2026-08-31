import { JOB_NAMES } from "./queues.ts";

/**
 * Everything that must happen after a verification succeeds, wherever it ran.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not two lines in two places
 * ---------------------------------------------------------------------------
 *
 * There are two ways an integration gets verified, and they do not share a code
 * path:
 *
 *   the admin panel's Save & Verify / Test Connection, which verifies INLINE in
 *     a server action and never enqueues a job;
 *   the integration.verify worker job, which the platform-wide repair fan-out
 *     enqueues.
 *
 * Commit 21 added "enqueue a numbers refresh after a successful verification"
 * to the second one only. Its commit message claimed a successful verification
 * was one of three triggers - and for the button an operator actually presses,
 * it was not. The effect was invisible: pressing Save & Verify verified
 * correctly, reported success, and silently never refreshed the numbers, so
 * every inbound message was skipped with unknown_phone_number_id because
 * whatsapp_numbers was empty. Nothing failed. Nothing logged. The worker tests
 * passed, because they call the worker handler directly.
 *
 * So the effects live here and neither caller performs them itself. A third
 * verification path - a CLI, a scheduled re-check - gets them by calling this,
 * and if it does not, the divergence test says so.
 */

/**
 * A queue's `add`, narrowed to what this needs.
 *
 * Injected rather than imported, because the two callers hold different Queue
 * instances: the web app's producer and the worker's. Taking the function makes
 * this module testable without a Redis, which is also how the divergence test
 * observes what each path did.
 */
export type EnqueueJob = (
  name: string,
  data: Record<string, unknown>,
  options: { jobId: string },
) => Promise<unknown>;

export interface VerificationEffectPorts {
  enqueue: EnqueueJob;
  /**
   * Told when an effect could not be applied.
   *
   * A warning and not a throw: the verification already happened and was
   * already recorded, and failing it afterwards would report a false negative
   * for work that succeeded. The next verification, webhook or button press
   * applies the effect instead.
   */
  onWarn?: (message: string, fields: Record<string, unknown>) => void;
}

export interface VerifiedIntegrations {
  companyId: string;
  /** Whether at least one integration verified. Nothing runs when nothing did. */
  verified: boolean;
  /**
   * A value unique to THIS verification, used in the job id.
   *
   * Unique, never stable per company, and that is R2: BullMQ keeps completed
   * ids for an hour and failed ones for a day, so a per-company id would make
   * the second Save & Verify within that window a silent no-op - which is
   * exactly the press an operator makes after fixing a credential.
   *
   * The worker passes its job id. The web passes a timestamp, since two presses
   * in the same millisecond collapsing is the behaviour we want anyway.
   */
  token: string;
}

/** The effects this owns, as names, so a caller can assert on the set. */
export const VERIFICATION_EFFECTS = {
  NUMBERS_REFRESH: JOB_NAMES.WHATSAPP_NUMBERS_REFRESH,
} as const;

export type VerificationEffect =
  (typeof VERIFICATION_EFFECTS)[keyof typeof VERIFICATION_EFFECTS];

/**
 * Apply them, and return the ones applied.
 *
 * The return value is the contract the divergence test compares: two paths that
 * verify the same thing must produce the same set, whatever else they each do
 * around it.
 */
export async function applyVerificationEffects(
  outcome: VerifiedIntegrations,
  ports: VerificationEffectPorts,
): Promise<VerificationEffect[]> {
  if (!outcome.verified) return [];

  const applied: VerificationEffect[] = [];

  /*
   * A successful verification is the moment a number's metadata is most likely
   * to be missing and the credentials are known good. It is one of the three
   * triggers for a refresh - the others being a person pressing Refresh on the
   * numbers page and Meta's phone_number_quality_update webhook.
   */
  try {
    await ports.enqueue(
      VERIFICATION_EFFECTS.NUMBERS_REFRESH,
      { companyId: outcome.companyId },
      { jobId: `numbers:${outcome.companyId}:${outcome.token}` },
    );
    applied.push(VERIFICATION_EFFECTS.NUMBERS_REFRESH);
  } catch (error) {
    ports.onWarn?.("could not enqueue a numbers refresh after verification", {
      companyId: outcome.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return applied;
}
