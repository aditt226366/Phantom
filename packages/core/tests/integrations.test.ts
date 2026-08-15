import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  effectiveIntegrationStatus,
  integrationFields,
  missingRequiredKeys,
  requiredIntegrationKeys,
} from "../src/integrations.ts";

/**
 * What the registry declares, and what the badge is allowed to say because of
 * it.
 *
 * The redactor's own enumeration over ALL_INTEGRATION_KEYS lives in
 * redact.test.ts and already covers every new key without being told; these
 * are about requiredness, which nothing else enforces.
 */

describe("required keys and what the badge may say", () => {
  it("declares requiredness for every field of every provider", () => {
    /*
     * `required` is not optional on IntegrationField, so this cannot fail at
     * runtime - it fails at compile time. Asserted anyway because the point is
     * that adding a credential forces the question, and a future refactor that
     * made the flag optional would remove that without anything noticing.
     */
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const field of integrationFields(provider)) {
        expect(typeof field.required, `${provider}.${field.key}`).toBe("boolean");
      }
    }
  });

  it("treats the app secret as required and secret", () => {
    const field = integrationFields("WHATSAPP_CLOUD").find(
      (f) => f.key === "WHATSAPP_APP_SECRET",
    );

    expect(field).toBeDefined();
    expect(field?.secret).toBe(true);
    expect(field?.required).toBe(true);
  });

  it("never presents an integration missing a required key as connected", () => {
    /*
     * The assertion this commit exists for, enumerated rather than sampled.
     *
     * For every provider and every required key, an integration holding
     * everything EXCEPT that one key must not read as connected - even though
     * the stored status says CONNECTED, which is what a verifier will
     * genuinely have written. verifyWhatsAppCloud calls GET /{phone_number_id}
     * and never touches the app secret, so CONNECTED is an honest record of a
     * successful call and a misleading answer to "will this work".
     */
    for (const provider of INTEGRATION_PROVIDERS) {
      const all = integrationFields(provider).map((f) => f.key);

      for (const omitted of requiredIntegrationKeys(provider)) {
        const held = all.filter((key) => key !== omitted);

        expect(
          missingRequiredKeys(provider, held),
          `${provider}: omitting ${omitted}`,
        ).toEqual([omitted]);

        expect(
          effectiveIntegrationStatus(provider, held, "CONNECTED"),
          `${provider} reads as connected without ${omitted}`,
        ).toBe("NOT_CONNECTED");
      }
    }
  });

  it("leaves a complete integration alone in both directions", () => {
    /*
     * The other half. A completeness check that answered NOT_CONNECTED for
     * everything would pass the test above and be useless, and one that
     * upgraded a failed verification to CONNECTED would be worse than useless.
     */
    for (const provider of INTEGRATION_PROVIDERS) {
      const all = integrationFields(provider).map((f) => f.key);

      expect(missingRequiredKeys(provider, all)).toEqual([]);
      expect(effectiveIntegrationStatus(provider, all, "CONNECTED")).toBe("CONNECTED");
      expect(effectiveIntegrationStatus(provider, all, "NOT_CONNECTED")).toBe(
        "NOT_CONNECTED",
      );
    }
  });

  it("does not hold a badge down for a key nothing reads yet", () => {
    /*
     * WHATSAPP_BUSINESS_ACCOUNT_ID is only needed by the Template Studio in
     * Phase 4b. Marking it required now would demote every WhatsApp card for a
     * value no code path consults, which is the lenient/strict mistake in the
     * other direction.
     */
    const businessAccountId = integrationFields("WHATSAPP_CLOUD").find(
      (f) => f.key === "WHATSAPP_BUSINESS_ACCOUNT_ID",
    );

    expect(businessAccountId?.required).toBe(false);
  });
});
