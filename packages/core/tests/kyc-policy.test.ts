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

describe("the exemption that must never exist", () => {
  /*
   * `npm run seed:dev` exists because of this suite's own subject.
   *
   * A4 shuts every feature section until three documents are approved, which
   * makes a freshly signed-up developer account useless - every page is the
   * gate. The obvious fix is a bypass: a `NODE_ENV !== "production"` arm here,
   * a SKIP_KYC variable, a second parameter carrying "allow anyway". The seed
   * script writes real approved rows instead, so a seeded company and a
   * company an operator approved by hand are indistinguishable, because there
   * is nothing to distinguish.
   *
   * This is what stops the bypass being added later, when the seed script is
   * two years old and somebody in a hurry wants a faster way through. The
   * repository has met that shape twice and written the rule down both times:
   * a guard that refuses its own only legitimate use gets DELETED rather than
   * fixed, six months later, by somebody who does not know what it was for.
   *
   * Asserted behaviourally rather than by reading the source. A grep for
   * "NODE_ENV" fails the day a comment explains why there is no NODE_ENV
   * check - which is the exact fault this repository has now hit four times,
   * most recently a comment stripper that ate a tsconfig glob. Running the
   * function under the environment a bypass would read cannot be fooled by
   * prose.
   *
   * And it is not redundant with the rest of this file, which was the first
   * thing checked. Adding `NODE_ENV === "development"` to canUseFeatures was
   * measured against the suite: every other test here passes, because vitest
   * runs with NODE_ENV=test and a bypass keyed on "development" is therefore
   * invisible to all of them. This one test failed alone.
   */

  const BYPASS_SHAPED = [
    "NODE_ENV",
    "SKIP_KYC",
    "KYC_BYPASS",
    "DISABLE_KYC",
    "ALLOW_UNVERIFIED",
    "SEED",
    "CI",
    "VITEST",
  ];

  it("stays shut in development, in test, and under every bypass-shaped name", () => {
    const saved = new Map(BYPASS_SHAPED.map((key) => [key, process.env[key]]));

    try {
      for (const key of BYPASS_SHAPED) process.env[key] = "1";
      /* The two that would be read for their VALUE rather than their presence. */
      process.env.NODE_ENV = "development";

      /* Nothing filed - the state a developer's own account is actually in. */
      expect(canUseFeatures(facts())).toEqual({
        allowed: false,
        reason: "documents_missing",
      });

      /* And a rejection stays a rejection, which is the case a "just let me in
         locally" arm would most want to wave through. */
      expect(
        canUseFeatures(facts({ documents: documents("APPROVED", "REJECTED", "APPROVED") })),
      ).toEqual({ allowed: false, reason: "documents_rejected" });

      /* A suspended workspace is not a local convenience either. */
      expect(
        canUseFeatures(facts({ companyDeactivated: true, documents: ALL_APPROVED })),
      ).toEqual({ allowed: false, reason: "company_deactivated" });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("takes the facts and nothing else", () => {
    /*
     * One parameter, structurally - so there is no second `options` argument
     * for a caller to pass `{ allowUnverified: true }` into.
     *
     * The environment check above catches a bypass the gate reads for itself;
     * this catches the other shape, where the gate stays pure and a caller is
     * given a way to ask for a different answer. Facts in, verdict out: a
     * caller that wants a different verdict has to change the facts, which
     * means writing the rows.
     */
    expect(canUseFeatures.length).toBe(1);
  });
});
