import { listIntegrations, saveIntegrationSecrets } from "@/lib/admin-db";
import { verifyIntegration } from "@/lib/integrations/verify";
import { createCompany, newCompanyId, withCompany } from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Verification end to end: read, decrypt, call, write.
 *
 * The provider is stubbed; everything else is real, including the database and
 * the encryption. What is being proved is the part no adapter test can cover —
 * that a transient failure does not move the badge.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";

let companyId: string;

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "integration_verifications", "integration_secrets",
                      "integrations", "usage_events", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  companyId = newCompanyId();
  await withCompany(companyId, (db, scoped) =>
    createCompany(db, scoped, "Verify Test"),
  );

  await saveIntegrationSecrets(companyId, "META_ADS", {
    META_ADS_ACCESS_TOKEN: TOKEN,
    META_AD_ACCOUNT_ID: "act_1234567890",
  });
});

function respondWith(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

async function status(): Promise<string | undefined> {
  const [integration] = await listIntegrations(companyId);
  return integration?.status;
}

async function verificationRows(): Promise<
  Array<{ ok: boolean; failure_kind: string | null; details: unknown }>
> {
  return superuser(async (client) => {
    const { rows } = await client.query(
      `SELECT ok, failure_kind, details FROM integration_verifications
        WHERE company_id = $1 ORDER BY created_at`,
      [companyId],
    );
    return rows;
  });
}

describe("a successful check", () => {
  it("marks the integration connected and stamps the time", async () => {
    const result = await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, { name: "Acme" }),
    });

    expect(result?.ok).toBe(true);

    const [integration] = await listIntegrations(companyId);
    expect(integration?.status).toBe("CONNECTED");
    expect(integration?.lastVerifiedAt).not.toBeNull();
    expect(integration?.lastError).toBeNull();
  });
});

describe("an auth failure", () => {
  it("demotes the badge", async () => {
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, { name: "Acme" }),
    });
    expect(await status()).toBe("CONNECTED");

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, {
        error: {
          message: "Error validating access token",
          code: 190,
          fbtrace_id: "AbCdEf123",
        },
      }),
    });

    expect(await status()).toBe("NOT_CONNECTED");
  });

  it("keeps the identifiers Meta support asks for", async () => {
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, {
        error: { message: "bad token", code: 190, fbtrace_id: "AbCdEf123" },
      }),
    });

    const [row] = await verificationRows();
    expect(row?.failure_kind).toBe("auth");
    expect(row?.details).toMatchObject({ code: 190, fbtrace_id: "AbCdEf123" });
  });
});

describe("a transient failure", () => {
  it("leaves a healthy badge alone", async () => {
    /*
     * The whole point. Meta has an outage; the credential is fine. Demoting
     * here tells every operator their integration is broken, and the response
     * to that is re-entering credentials that were never wrong.
     */
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, { name: "Acme" }),
    });
    expect(await status()).toBe("CONNECTED");

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(503, { error: { message: "Service unavailable" } }),
    });

    expect(await status()).toBe("CONNECTED");
  });

  it("still records the error and the attempt", async () => {
    /* Invisible would be as bad as demoting: the operator needs to know a
       check ran and what came back. */
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(503, { error: { message: "Service unavailable" } }),
    });

    const [integration] = await listIntegrations(companyId);
    expect(integration?.lastError).toContain("Service unavailable");

    const rows = await verificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.failure_kind).toBe("transient");
  });

  it("does not promote a broken integration either", async () => {
    /* Leaving the status untouched has to cut both ways, or a 503 would
       quietly rescue a credential that is genuinely revoked. */
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, { error: { message: "bad", code: 190 } }),
    });
    expect(await status()).toBe("NOT_CONNECTED");

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(503, { error: { message: "down" } }),
    });

    expect(await status()).toBe("NOT_CONNECTED");
  });
});

describe("what gets written", () => {
  it("never stores the token, even when the provider echoes it", async () => {
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, {
        error: { message: `Invalid OAuth access token: ${TOKEN}`, code: 190 },
      }),
    });

    const rows = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT error FROM integration_verifications WHERE company_id = $1`,
        [companyId],
      );
      return rows;
    });

    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).toContain("[redacted]");
  });

  it("records a usage event for the call", async () => {
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, {}),
      dedupeSuffix: "run-1",
    });

    const rows = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT kind, dedupe_key FROM usage_events WHERE company_id = $1`,
        [companyId],
      );
      return rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("integration.verify");
  });

  it("charges once when the same run is retried", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await verifyIntegration(companyId, "META_ADS", {
        fetchImpl: respondWith(200, {}),
        dedupeSuffix: "run-7",
      });
    }

    const rows = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM usage_events WHERE company_id = $1`,
        [companyId],
      );
      return rows;
    });

    expect(rows).toHaveLength(1);
  });
});

describe("a secret that will not open", () => {
  it("reports a decryption fault as config, not as a refused credential", async () => {
    /*
     * A dropped encryption key or a row moved between companies. Saying "auth"
     * would send an operator to re-enter a credential that is fine, and the
     * message has to name the real problem.
     */
    await superuser((client) =>
      client.query(
        `UPDATE integration_secrets SET ciphertext = 'v2.k1.AAAA.BBBB.CCCC'
          WHERE company_id = $1`,
        [companyId],
      ),
    );

    const result = await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, {}),
    });

    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.kind).toBe("config");
    expect(result.error).toMatch(/could not be decrypted/i);
  });
});

describe("an integration that does not exist", () => {
  it("returns null rather than inventing one", async () => {
    expect(
      await verifyIntegration(companyId, "GOOGLE_SHEETS", {
        fetchImpl: respondWith(200, {}),
      }),
    ).toBeNull();
  });
});
