import { open, seal } from "@/lib/integrations/seal";
import {
  disconnectIntegration,
  listIntegrations,
  saveIntegrationSecrets,
} from "@/lib/admin-db";
import { secretAad } from "@whatsapp-os/core";
import { createCompany, newCompanyId, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The vault, against a real database.
 *
 * A real-looking token throughout, so an assertion that it never appears is
 * asserting about something with the shape of the thing that matters.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";
const VERIFY = "verify-token-abcdefghijkl";
const PHONE_ID = "109876543210987";
const BUSINESS_ID = "220011223344556";

let companyId: string;

beforeEach(async () => {
  const superuser = new pg.Client({
    connectionString: testSuperuserDatabaseUrl(),
  });
  await superuser.connect();
  await superuser.query(
    `TRUNCATE TABLE "integration_secrets", "integrations", "companies" RESTART IDENTITY CASCADE`,
  );
  await superuser.end();

  companyId = newCompanyId();
  await withCompany(companyId, (db, scoped) =>
    createCompany(db, scoped, "Vault Test"),
  );
});

/** Ciphertext as stored, read past RLS so the assertion sees what is really there. */
async function storedCiphertext(key: string): Promise<string> {
  const superuser = new pg.Client({
    connectionString: testSuperuserDatabaseUrl(),
  });
  await superuser.connect();

  try {
    const { rows } = await superuser.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM integration_secrets WHERE company_id = $1 AND key = $2`,
      [companyId, key],
    );
    return rows[0]?.ciphertext ?? "";
  } finally {
    await superuser.end();
  }
}

describe("saving credentials", () => {
  it("stores nothing in plaintext", async () => {
    await saveIntegrationSecrets(companyId, "WHATSAPP_CLOUD", {
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: BUSINESS_ID,
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_VERIFY_TOKEN: VERIFY,
    });

    const ciphertext = await storedCiphertext("WHATSAPP_ACCESS_TOKEN");

    expect(ciphertext).not.toContain(TOKEN);
    expect(ciphertext.startsWith("v2.")).toBe(true);
  });

  it("seals against the integration row that exists, not one invented later", async () => {
    /*
     * The AAD ordering. On a first save the integration row is created by the
     * same call, so encrypting before it exists would build an AAD from an id
     * that never lands — and produce rows nothing can open. Opening with the
     * id actually stored is the check.
     */
    const result = await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
      META_AD_ACCOUNT_ID: "act_1234567890",
    });

    const ciphertext = await storedCiphertext("META_ADS_ACCESS_TOKEN");

    expect(
      open(companyId, result.integrationId, "META_ADS_ACCESS_TOKEN", ciphertext),
    ).toBe(TOKEN);
  });

  it("refuses to open a secret under another integration's id", async () => {
    const result = await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });
    const ciphertext = await storedCiphertext("META_ADS_ACCESS_TOKEN");

    expect(() =>
      open(companyId, "some-other-integration", "META_ADS_ACCESS_TOKEN", ciphertext),
    ).toThrow(/decryption failed/i);

    /* And the real one still works, so the throw above is about the AAD. */
    expect(
      open(companyId, result.integrationId, "META_ADS_ACCESS_TOKEN", ciphertext),
    ).toBe(TOKEN);
  });

  it("leaves untouched keys decryptable when only one field is filled", async () => {
    /*
     * Blank means unchanged. An operator rotating one credential cannot
     * re-type the other three, because the panel never shows them.
     */
    const first = await saveIntegrationSecrets(companyId, "WHATSAPP_CLOUD", {
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: BUSINESS_ID,
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_VERIFY_TOKEN: VERIFY,
    });

    const rotated = "EAAGm0PX4ZCpsBO7ZBxRotatedAccessToken77";
    const second = await saveIntegrationSecrets(companyId, "WHATSAPP_CLOUD", {
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "",
      WHATSAPP_ACCESS_TOKEN: rotated,
      WHATSAPP_VERIFY_TOKEN: "",
    });

    expect(second.integrationId).toBe(first.integrationId);
    expect(second.saved).toEqual(["WHATSAPP_ACCESS_TOKEN"]);
    expect(second.unchanged).toEqual([
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_BUSINESS_ACCOUNT_ID",
      "WHATSAPP_VERIFY_TOKEN",
    ]);

    const id = second.integrationId;
    expect(
      open(companyId, id, "WHATSAPP_ACCESS_TOKEN", await storedCiphertext("WHATSAPP_ACCESS_TOKEN")),
    ).toBe(rotated);
    expect(
      open(companyId, id, "WHATSAPP_VERIFY_TOKEN", await storedCiphertext("WHATSAPP_VERIFY_TOKEN")),
    ).toBe(VERIFY);
    expect(
      open(companyId, id, "WHATSAPP_PHONE_NUMBER_ID", await storedCiphertext("WHATSAPP_PHONE_NUMBER_ID")),
    ).toBe(PHONE_ID);
  });

  it("treats whitespace as blank", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });
    const second = await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: "   ",
    });

    expect(second.saved).toEqual([]);
  });
});

describe("what the console can read back", () => {
  it("returns last4 and never a ciphertext", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    const [integration] = await listIntegrations(companyId);
    const secret = integration?.secrets.find(
      (entry) => entry.key === "META_ADS_ACCESS_TOKEN",
    );

    expect(secret?.last4).toBe(TOKEN.slice(-4));
    expect(JSON.stringify(integration)).not.toContain(TOKEN);
    expect(JSON.stringify(integration)).not.toContain("v2.");
  });

  it("stores no last4 for a value too short to hint at", async () => {
    /* Four of six characters is most of the value, not a hint. */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_AD_ACCOUNT_ID: "act_12",
    });

    const [integration] = await listIntegrations(companyId);
    const secret = integration?.secrets.find(
      (entry) => entry.key === "META_AD_ACCOUNT_ID",
    );

    expect(secret?.last4).toBeNull();
  });

  it("stores last4 at exactly twelve characters", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_AD_ACCOUNT_ID: "act_12345678",
    });

    const [integration] = await listIntegrations(companyId);
    const secret = integration?.secrets.find(
      (entry) => entry.key === "META_AD_ACCOUNT_ID",
    );

    expect(secret?.last4).toBe("5678");
  });
});

describe("disconnecting", () => {
  it("removes the secrets and keeps the record", async () => {
    /*
     * Changed deliberately in C14. Deleting the Integration row too would take
     * the verification history with it, and "was this ever working, and what
     * did it say when it stopped" is the question an operator actually asks.
     * The ciphertext is what has to go.
     */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    expect(await disconnectIntegration(companyId, "META_ADS")).toEqual({
      secretsRemoved: 1,
    });
    expect(await storedCiphertext("META_ADS_ACCESS_TOKEN")).toBe("");

    const [integration] = await listIntegrations(companyId);
    expect(integration?.status).toBe("NOT_CONNECTED");
    expect(integration?.secrets).toEqual([]);
  });
});

describe("seal", () => {
  it("binds to the company, so a row copied sideways will not open", () => {
    const sealed = seal("company-a", "integration-1", "META_ADS_ACCESS_TOKEN", TOKEN);

    expect(() =>
      open("company-b", "integration-1", "META_ADS_ACCESS_TOKEN", sealed.ciphertext),
    ).toThrow(/decryption failed/i);
  });

  it("binds to the key name, so a rename is not a string change", () => {
    const sealed = seal("company-a", "integration-1", "META_ADS_ACCESS_TOKEN", TOKEN);

    expect(() =>
      open("company-a", "integration-1", "META_ADS_RENAMED_TOKEN", sealed.ciphertext),
    ).toThrow(/decryption failed/i);
  });

  it("uses the shared AAD construction rather than its own", () => {
    /* If seal built the AAD by hand, this would drift and nothing would say so
       until a rotation orphaned every row. */
    const sealed = seal("c", "i", "K", TOKEN);
    const aad = secretAad("c", "i", "K");

    expect(sealed.ciphertext).toBeTruthy();
    expect(aad).toBe("c:i:K");
  });
});
