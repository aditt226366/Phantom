import { createCompany, newCompanyId, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { saveIntegrationSecrets } from "@/lib/admin-db";
import { auditVault, vaultIsHealthy } from "@/lib/integrations/vault-audit";
import { keyring } from "@/lib/integrations/seal";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The rotation gate.
 *
 * Key-id counts can be perfect while the vault is broken — a row can carry the
 * right key_id and still not open. This is what the drop-the-old-key step is
 * gated on, so it has to detect that.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";

/*
 * Read, never hardcoded. These assertions named "k1" until a real key rotation
 * left the development .env on k2 and broke three of them — a test that
 * depends on which keys a developer happens to have configured is a test that
 * fails for a reason having nothing to do with the code.
 */
const ACTIVE = keyring().activeId;

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

let companyId: string;

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "integration_secrets", "integrations", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  companyId = newCompanyId();
  await withCompany(companyId, (db, scoped) =>
    createCompany(db, scoped, "Audit Test"),
  );
});

describe("a healthy vault", () => {
  it("opens every row and reports the key they are on", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
      META_AD_ACCOUNT_ID: "act_1234567890",
    });

    const audit = await auditVault();

    expect(audit.total).toBe(2);
    expect(audit.missingKey).toBe(0);
    expect(audit.badContext).toBe(0);
    expect(audit.byKeyId).toEqual({ [ACTIVE]: 2 });
    expect(vaultIsHealthy(audit)).toBe(true);
  });

  it("passes on an empty vault", async () => {
    const audit = await auditVault();

    expect(audit.total).toBe(0);
    expect(vaultIsHealthy(audit)).toBe(true);
  });

  it("returns no plaintext anywhere in its result", async () => {
    /*
     * The audit opens every row and must keep nothing. Success is the whole
     * assertion; the value is discarded on the next line.
     */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    const audit = await auditVault();

    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(JSON.stringify(audit)).not.toContain("v2.");
  });
});

describe("a row whose key is gone", () => {
  it("is counted and named, not skipped", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    /* Rewritten as though sealed by a key that is not in the keyring. */
    await superuser((client) =>
      client.query(
        `UPDATE integration_secrets
            SET key_id = 'k9',
                ciphertext = replace(ciphertext, $2, 'v2.k9.')
          WHERE company_id = $1`,
        [companyId, `v2.${ACTIVE}.`],
      ),
    );

    const audit = await auditVault();

    expect(audit.missingKey).toBe(1);
    expect(audit.badContext).toBe(0);
    expect(audit.problems[0]?.reason).toBe("missingKey");
    expect(audit.problems[0]?.keyId).toBe("k9");
    expect(vaultIsHealthy(audit)).toBe(false);
  });
});

describe("a row that no longer matches its coordinates", () => {
  it("is detected even though the key is present", async () => {
    /*
     * The failure key-id counts cannot see. The ciphertext is well-formed, the
     * key that sealed it is right there, and it still will not open — because
     * the row was moved to a different integration and the AAD no longer
     * matches. Exactly what a copied row looks like.
     */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    /*
     * A second, real integration to move it to. The foreign key already stops
     * a row pointing at one that does not exist, so the reachable corruption
     * is a row that moved between two integrations that both do — which is
     * what a copied row looks like.
     */
    const sheets = await saveIntegrationSecrets(companyId, "GOOGLE_SHEETS", {
      GOOGLE_SHEETS_ID: "1A2B3C4D5E6F7G8H",
    });

    await superuser((client) =>
      client.query(
        `UPDATE integration_secrets SET integration_id = $2
          WHERE company_id = $1 AND key = 'META_ADS_ACCESS_TOKEN'`,
        [companyId, sheets.integrationId],
      ),
    );

    const audit = await auditVault();

    expect(audit.missingKey).toBe(0);
    expect(audit.badContext).toBe(1);
    expect(audit.problems[0]?.reason).toBe("badContext");
    /* Every row is on the active key — counts alone would say all clear. */
    expect(audit.byKeyId).toEqual({ [ACTIVE]: 2 });
    expect(vaultIsHealthy(audit)).toBe(false);
  });

  it("is detected when the key name it sits under changes", async () => {
    /* Renaming a credential in the registry without re-encrypting. */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });

    await superuser((client) =>
      client.query(
        `UPDATE integration_secrets SET key = 'META_ADS_RENAMED_TOKEN'
          WHERE company_id = $1`,
        [companyId],
      ),
    );

    const audit = await auditVault();

    expect(audit.badContext).toBe(1);
    expect(vaultIsHealthy(audit)).toBe(false);
  });
});

describe("the gate", () => {
  it("is false whenever anything cannot be opened", () => {
    expect(
      vaultIsHealthy({
        total: 10,
        byKeyId: { k2: 10 },
        missingKey: 0,
        badContext: 1,
        problems: [],
      }),
    ).toBe(false);

    expect(
      vaultIsHealthy({
        total: 10,
        byKeyId: { k2: 10 },
        missingKey: 1,
        badContext: 0,
        problems: [],
      }),
    ).toBe(false);
  });
});
