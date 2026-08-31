import { describe, expect, it } from "vitest";
import {
  KYC_KINDS,
  canUseFeatures,
  featuresBlocked,
  type FeatureFacts,
  type KycStatus,
  type KycStatuses,
} from "../src/kyc/index.ts";

/**
 * The gate, which A4 makes the most consequential pure function in the system.
 *
 * Everything is shut until this says otherwise, so the assertions worth having
 * are the ones about it opening. A gate that refuses too much is a support
 * ticket; a gate that opens by accident is the reason the phase exists.
 */

/** Nothing filed, workspace active - where every real tenant starts. */
function facts(overrides: Partial<FeatureFacts> = {}): FeatureFacts {
  return {
    companyDeactivated: false,
    documents: { GST: null, PAN: null, AADHAAR: null },
    ...overrides,
  };
}

function documents(
  gst: KycStatus | null,
  pan: KycStatus | null,
  aadhaar: KycStatus | null,
): KycStatuses {
  return { GST: gst, PAN: pan, AADHAAR: aadhaar };
}

const ALL_APPROVED = documents("APPROVED", "APPROVED", "APPROVED");

describe("the only way through", () => {
  it("opens when all three are approved", () => {
    expect(canUseFeatures(facts({ documents: ALL_APPROVED }))).toEqual({
      allowed: true,
    });
  });

  it("stays shut if any single kind is not approved", () => {
    /*
     * Iterated rather than written out three times, because the interesting
     * claim is "any one of them", not "this particular one". A hand-written
     * pair of cases would have left whichever kind was forgotten open.
     */
    for (const kind of KYC_KINDS) {
      for (const status of ["PENDING", "REJECTED", null] as const) {
        const withHole: KycStatuses = { ...ALL_APPROVED, [kind]: status };

        expect(
          canUseFeatures(facts({ documents: withHole })).allowed,
          `${kind} = ${status} opened the product`,
        ).toBe(false);
      }
    }
  });
});

describe("the reason", () => {
  it("reports a suspended workspace ahead of everything", () => {
    /*
     * Least recoverable first. Telling somebody to send their PAN card when
     * the account is suspended is advice that wastes their afternoon - no
     * amount of uploading moves it.
     */
    const decision = canUseFeatures(
      facts({ companyDeactivated: true, documents: ALL_APPROVED }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "company_deactivated",
    });
  });

  it("reports nothing filed as missing", () => {
    expect(canUseFeatures(facts())).toEqual({
      allowed: false,
      reason: "documents_missing",
    });
  });

  it("reports a refusal ahead of a missing document", () => {
    /*
     * The one ordering choice here that is not obvious, so it is asserted
     * rather than left to the implementation. Both need the tenant to act, so
     * neither is more recoverable - but a tenant who filed something and had
     * it refused is the person most likely to believe they are simply waiting.
     * "You have not uploaded your PAN card" is self-evident from the page; a
     * refusal is the thing somebody has to be told.
     */
    const decision = canUseFeatures(
      facts({ documents: documents("REJECTED", null, "APPROVED") }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "documents_rejected",
    });
  });

  it("reports pending only when there is nothing to do", () => {
    const decision = canUseFeatures(
      facts({ documents: documents("APPROVED", "PENDING", "APPROVED") }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "documents_pending",
    });
  });
});

describe("revocation", () => {
  it("closes the gate again", () => {
    /*
     * The case that proves this is a function of current state and not of
     * anything decided once. An operator withdrawing an approval writes
     * REJECTED, and the very next call refuses - which is only true for
     * callers that read it per request, and is why nothing may cache it.
     */
    const before = canUseFeatures(facts({ documents: ALL_APPROVED }));
    const after = canUseFeatures(
      facts({ documents: { ...ALL_APPROVED, AADHAAR: "REJECTED" } }),
    );

    expect(before.allowed).toBe(true);
    expect(after).toEqual({ allowed: false, reason: "documents_rejected" });
  });
});

describe("failing closed", () => {
  it("refuses a status it has never heard of", () => {
    /*
     * The final arm states "every kind APPROVED" positively rather than
     * falling through the three refusals, and this is the difference. A
     * fall-through would OPEN the product for a status added to the enum
     * later - it is not any of the three things checked above - and it would
     * do so silently, in the one function whose job is to be shut.
     *
     * Cast because the point is a value outside the type: this asserts what
     * happens when the database grows a member this build has never seen,
     * which is exactly how whatsapp_numbers.status behaved in 20260816100000.
     */
    const unknown = { ...ALL_APPROVED, GST: "UNDER_REVIEW" as KycStatus };

    expect(canUseFeatures(facts({ documents: unknown }))).toEqual({
      allowed: false,
      reason: "documents_pending",
    });
  });
});

describe("the predicate form", () => {
  it("agrees with the decision in both directions", () => {
    /* Derived, never written twice. A second implementation of "is it open" is
       how the gate and the page explaining the gate come to disagree. */
    expect(featuresBlocked(facts({ documents: ALL_APPROVED }))).toBe(false);
    expect(featuresBlocked(facts())).toBe(true);
  });
});
