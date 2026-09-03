import { describe, expect, it } from "vitest";
import {
  ALL_INTEGRATION_KEYS,
  EXPIRY_TRACKED_KEYS,
  INTEGRATION_PROVIDERS,
  effectiveIntegrationStatus,
  expiryTrackedKey,
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

  /*
   * The inverse of what this asserted through 4a, and the flip is the point.
   *
   * WHATSAPP_BUSINESS_ACCOUNT_ID was optional for exactly as long as nothing
   * read it: a key that demotes a badge while no code path would notice its
   * absence teaches operators to ignore the badge, which is the lenient/strict
   * mistake in the other direction.
   *
   * The Template Studio reads it - every template call is scoped to the WABA -
   * so without it the Studio submits nothing and the Library syncs nothing.
   * Required now, and demoting the badge is the correct report rather than a
   * nuisance.
   */
  it("holds the badge down once the Studio needs the WABA id", () => {
    const businessAccountId = integrationFields("WHATSAPP_CLOUD").find(
      (f) => f.key === "WHATSAPP_BUSINESS_ACCOUNT_ID",
    );

    expect(businessAccountId?.required).toBe(true);
  });

  /*
   * And the consequence, asserted rather than assumed: a WhatsApp integration
   * missing only this key reports NOT_CONNECTED however green the stored status
   * is. That is the derived status doing its job - the panel must not say
   * CONNECTED about an integration that cannot do half of what it is for.
   */
  it("reports a WhatsApp integration without a WABA id as not connected", () => {
    const withoutWaba = integrationFields("WHATSAPP_CLOUD")
      .map((f) => f.key)
      .filter((key) => key !== "WHATSAPP_BUSINESS_ACCOUNT_ID");

    expect(missingRequiredKeys("WHATSAPP_CLOUD", withoutWaba)).toEqual([
      "WHATSAPP_BUSINESS_ACCOUNT_ID",
    ]);
    expect(
      effectiveIntegrationStatus("WHATSAPP_CLOUD", withoutWaba, "CONNECTED"),
    ).toBe("NOT_CONNECTED");
  });
});

describe("the credentials whose expiry is tracked", () => {
  it("names keys that actually exist", () => {
    /*
     * The coupling that keeps EXPIRY_TRACKED_KEYS honest. Each entry is a
     * bare string, so a rename in INTEGRATION_FIELDS would leave it pointing
     * at nothing - and expiry tracking would switch off silently, behind a
     * diff that looks like a tidy-up. A credential rename is already
     * expensive here (the key is part of the AAD, so it is a
     * decrypt-and-re-encrypt); this makes it loud as well as expensive.
     */
    const declared = new Set(ALL_INTEGRATION_KEYS);
    const dangling = [...EXPIRY_TRACKED_KEYS].filter((key) => !declared.has(key));

    expect(
      dangling,
      "these keys are tracked for expiry but no provider declares them",
    ).toEqual([]);
  });

  it("resolves the governing credential per provider", () => {
    expect(expiryTrackedKey("META_ADS")).toBe("META_ADS_ACCESS_TOKEN");

    /* Named absences. Neither of these has an expiry this system records, and
       for WhatsApp that is a real gap rather than a property of the token -
       see the comment on EXPIRY_TRACKED_KEYS. */
    expect(expiryTrackedKey("GOOGLE_SHEETS")).toBeNull();
    expect(expiryTrackedKey("WHATSAPP_CLOUD")).toBeNull();
  });
});
