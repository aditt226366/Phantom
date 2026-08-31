/**
 * Whether a company may use the product at all.
 *
 * ---------------------------------------------------------------------------
 * This is A4, and A4 changed what the answer means
 * ---------------------------------------------------------------------------
 *
 * The original plan gated *sending* on verification. It now gates everything.
 * An unverified account can do four things - sign in, sign out, keep its
 * personal details current, and file documents - and nothing else. Not a
 * banner, not a degraded mode with the dangerous buttons hidden: blocked.
 *
 * So this function is not a hint for the user interface. It is the boundary,
 * and it is enforced in every loader and every action of every feature
 * section, never by hiding a nav item and never in a layout. Layouts are
 * cached per segment and are not guaranteed to re-execute on every navigation
 * within one, which makes a check there a redirect for the user's benefit
 * rather than a wall. Rule 4 has said so since Phase 1; this is the phase that
 * tests it.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason sendPolicy is pure
 * ---------------------------------------------------------------------------
 *
 * It takes facts and returns a verdict with no I/O. Fetching the facts is the
 * caller's job, and that split is what lets the same function answer for a
 * page loader, a server action, the send path and the worker - four callers
 * that acquire the facts very differently and must never disagree about what
 * they mean.
 *
 * The one thing callers must not do is cache the answer for longer than a
 * request. An approval can be revoked, and the gate closing again is the case
 * that proves this is read per request rather than decided at sign-in.
 */

/**
 * The three documents, in the order every surface renders them.
 *
 * Here rather than beside the database enum because the ordering is a product
 * decision, not a schema one: enum member order in schema.prisma must never
 * quietly become a rendering rule, and a tenant seeing GST, PAN, Aadhaar on
 * one screen and a different order on the next has to read both twice.
 */
export const KYC_KINDS = ["GST", "PAN", "AADHAAR"] as const;

export type KycKind = (typeof KYC_KINDS)[number];

/** Mirrors kyc_document_status. Null means nothing of that kind was ever filed. */
export type KycStatus = "PENDING" | "APPROVED" | "REJECTED";

/** The newest upload of each kind, reduced to the only field a verdict needs. */
export type KycStatuses = Record<KycKind, KycStatus | null>;

/**
 * Why the product is closed to this company.
 *
 * A closed union of machine codes, never a sentence, for the reason
 * SendRefusal gives: a refusal travels. It reaches a blocked page, a server
 * action's return value, the send path and the worker's logs, and prose would
 * eventually be matched on - somebody writes `if (reason.includes("pending"))`
 * and it works until the copy is reworded. The human sentence is produced
 * where it is displayed.
 */
export type FeatureBlock =
  /** The workspace is suspended. Nothing the tenant does will change this. */
  | "company_deactivated"
  /** At least one document was refused, or had its approval withdrawn. */
  | "documents_rejected"
  /** At least one of the three has never been filed. */
  | "documents_missing"
  /** All three are filed and at least one is still waiting on a decision. */
  | "documents_pending";

export type FeatureAccess =
  | { allowed: true }
  | { allowed: false; reason: FeatureBlock };

export interface FeatureFacts {
  /** companies.deactivated_at is not null. */
  companyDeactivated: boolean;
  /** The status of the NEWEST document of each kind - see currentKycDocuments. */
  documents: KycStatuses;
}

/**
 * Order matters, and it is least-recoverable first, then least-obvious.
 *
 * A suspended workspace is reported ahead of everything because no amount of
 * uploading will move it, and telling somebody to send their PAN card when the
 * account is suspended is advice that wastes their afternoon.
 *
 * Rejection is reported ahead of a missing document, which is the one ordering
 * choice here that is not obvious. Both need the tenant to act, so neither is
 * more recoverable than the other - but a tenant who has uploaded all three
 * and been refused one is the person most likely to think they are simply
 * waiting. "Missing" is self-evident from the page; a refusal is the thing
 * somebody has to be told.
 *
 * Pending is last because it is the only one where the right action is to do
 * nothing.
 */
export function canUseFeatures(facts: FeatureFacts): FeatureAccess {
  if (facts.companyDeactivated) {
    return { allowed: false, reason: "company_deactivated" };
  }

  const statuses = KYC_KINDS.map((kind) => facts.documents[kind]);

  if (statuses.some((status) => status === "REJECTED")) {
    return { allowed: false, reason: "documents_rejected" };
  }

  if (statuses.some((status) => status === null)) {
    return { allowed: false, reason: "documents_missing" };
  }

  /*
   * The remaining opening is stated positively - every kind APPROVED - rather
   * than reached by falling through the three refusals above.
   *
   * The two are equivalent today and stop being equivalent the moment a fourth
   * status is added to the enum. A fall-through would then OPEN the product
   * for the new value, silently, because it is not any of the three things
   * checked above; this fails closed instead, and the new status has to be
   * given a verdict deliberately. That is the right way round for a gate whose
   * whole job is to be shut.
   */
  if (statuses.every((status) => status === "APPROVED")) {
    return { allowed: true };
  }

  return { allowed: false, reason: "documents_pending" };
}

/**
 * Is this company blocked? The predicate form, for a caller that has no use
 * for the reason.
 *
 * Deliberately derived from canUseFeatures rather than written again. A second
 * implementation of "is it open" is how the gate and the page that explains
 * the gate end up disagreeing.
 */
export function featuresBlocked(facts: FeatureFacts): boolean {
  return !canUseFeatures(facts).allowed;
}
