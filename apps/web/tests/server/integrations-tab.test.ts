import { renderToStaticMarkup } from "react-dom/server";
import {
  createCompany,
  newCompanyId,
  withCompany,
} from "@whatsapp-os/db";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectIntegration,
  listIntegrations,
  listVerifications,
  saveIntegrationSecrets,
} from "@/lib/admin-db";
import { verifyIntegration } from "@/lib/integrations/verify";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * The integrations tab, against a real database.
 */

vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => ({
    sessionId: "session",
    adminUserId: "admin",
    username: "operator",
    csrfSecret: "csrf",
  }),
  assertAdminCsrf: async () => undefined,
}));

vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: undefined, userAgent: undefined }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";
const ACCOUNT = "act_1234567890";

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
      `TRUNCATE TABLE "integration_verifications", "integration_secrets",
                      "integrations", "usage_events", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  companyId = newCompanyId();
  await withCompany(companyId, (db, scoped) =>
    createCompany(db, scoped, "Integrations Test"),
  );
});

function respondWith(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

async function seedMetaAds(): Promise<void> {
  await saveIntegrationSecrets(companyId, "META_ADS", {
    META_ADS_ACCESS_TOKEN: TOKEN,
    META_AD_ACCOUNT_ID: ACCOUNT,
  });
}

/** Every 12-character window of a secret, so a partial leak still counts. */
function fragmentsOf(secret: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start + 12 <= secret.length; start += 4) {
    parts.push(secret.slice(start, start + 12));
  }
  return parts;
}

describe("the debug details panel", () => {
  it("renders no substring of a stored secret", async () => {
    /*
     * The panel reads stored verification rows and nothing else. Everything it
     * shows was scrubbed at write time, which is what makes it safe — and this
     * is the surface where "just the first six characters, for support" gets
     * proposed under pressure.
     *
     * A failure Meta echoes the token back into, so the row it renders is the
     * worst realistic case rather than a clean one.
     */
    await seedMetaAds();

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, {
        error: {
          message: `Invalid OAuth access token: ${TOKEN}`,
          code: 190,
          fbtrace_id: "AbCdEf123",
        },
      }),
    });

    const { DebugDetails } = await import(
      "@/app/(admin)/admin/_components/integration-card"
    );

    const { entries } = await listVerifications(companyId);

    /*
     * The panel itself, rendered. The surrounding card embeds the credential
     * form, which is a client component and cannot be rendered to static
     * markup — and it is not the surface this test is about.
     */
    const markup = renderToStaticMarkup(
      DebugDetails({ entry: entries[0] }) as React.ReactElement,
    );

    for (const fragment of fragmentsOf(TOKEN)) {
      expect(markup, `markup leaked "${fragment}"`).not.toContain(fragment);
    }
    expect(markup).not.toContain(ACCOUNT);

    /* And it is not blank: the diagnostic value survived the scrubbing. */
    expect(markup).toContain("Debug details");
    expect(markup).toContain("AbCdEf123");
    expect(markup).toContain("[redacted]");
  });

  it("never reads a ciphertext either", async () => {
    await seedMetaAds();

    const [integration] = await listIntegrations(companyId);

    /* listIntegrations is the only read the card gets, and it selects no
       ciphertext column at all. */
    expect(JSON.stringify(integration)).not.toContain("v2.");
  });
});

describe("disconnect", () => {
  it("deletes the stored secrets rather than flipping a label", async () => {
    /*
     * A disconnect that only changed the badge would leave a live token in the
     * vault for a provider the panel says is not connected.
     */
    await seedMetaAds();

    const before = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM integration_secrets WHERE company_id = $1`,
        [companyId],
      );
      return rows.length;
    });
    expect(before).toBe(2);

    const result = await disconnectIntegration(companyId, "META_ADS");

    expect(result).toEqual({ secretsRemoved: 2 });

    const after = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM integration_secrets WHERE company_id = $1`,
        [companyId],
      );
      return rows.length;
    });
    expect(after).toBe(0);
  });

  it("keeps the integration and its history", async () => {
    /* "Was this ever working, and what did it say when it stopped" is a
       reasonable question, and the history is the only thing that answers it. */
    await seedMetaAds();
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, { name: "Acme" }),
    });

    await disconnectIntegration(companyId, "META_ADS");

    const [integration] = await listIntegrations(companyId);
    expect(integration).toBeDefined();
    expect(integration?.status).toBe("NOT_CONNECTED");
    expect(integration?.secrets).toEqual([]);

    const { entries } = await listVerifications(companyId);
    expect(entries).toHaveLength(1);
  });

  it("returns null for a provider that was never connected", async () => {
    expect(await disconnectIntegration(companyId, "GOOGLE_SHEETS")).toBeNull();
  });
});

describe("testing a connection with nothing stored", () => {
  it("refuses without calling the provider", async () => {
    /*
     * Calling out with empty strings gets a generic auth error back, which
     * reads as "your credentials are wrong" for credentials that were never
     * entered — and sends the operator to re-enter values that do not exist.
     */
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });
    await disconnectIntegration(companyId, "META_ADS");

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await verifyIntegration(companyId, "META_ADS", { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.kind).toBe("config");
    expect(result.error).toMatch(/no credentials are stored/i);
  });

  it("charges no usage for a call that never happened", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });
    await disconnectIntegration(companyId, "META_ADS");

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const usage = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM usage_events WHERE company_id = $1`,
        [companyId],
      );
      return rows.length;
    });

    expect(usage).toBe(0);
  });

  it("still records the attempt, so the log is not silent", async () => {
    await saveIntegrationSecrets(companyId, "META_ADS", {
      META_ADS_ACCESS_TOKEN: TOKEN,
    });
    await disconnectIntegration(companyId, "META_ADS");

    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const { entries } = await listVerifications(companyId);
    expect(entries[0]?.failureKind).toBe("config");
  });

  it("does not demote a badge for a check that was never made", async () => {
    await seedMetaAds();
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(200, {}),
    });
    expect((await listIntegrations(companyId))[0]?.status).toBe("CONNECTED");
  });
});

describe("verification logs", () => {
  it("are bounded and paged", async () => {
    await seedMetaAds();

    for (let index = 0; index < 5; index++) {
      await verifyIntegration(companyId, "META_ADS", {
        fetchImpl: respondWith(200, {}),
        dedupeSuffix: `run-${index}`,
      });
    }

    const first = await listVerifications(companyId, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listVerifications(companyId, {
      limit: 2,
      cursor: first.nextCursor!,
    });

    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps the limit however large a cursor URL asks", async () => {
    await seedMetaAds();
    const page = await listVerifications(companyId, { limit: 100000 });

    /* Clamped rather than rejected: a log view should degrade, not 500. */
    expect(page.entries.length).toBeLessThanOrEqual(100);
  });

  it("stores no secret in what it renders", async () => {
    await seedMetaAds();
    await verifyIntegration(companyId, "META_ADS", {
      fetchImpl: respondWith(400, {
        error: { message: `Invalid OAuth access token: ${TOKEN}`, code: 190 },
      }),
    });

    const { entries } = await listVerifications(companyId);

    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });
});
