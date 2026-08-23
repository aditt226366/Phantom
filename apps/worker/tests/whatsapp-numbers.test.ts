import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the refresh job does around the Graph call.
 *
 * The write itself - upsert, and marking what Meta did not return - is proved
 * against a real database in packages/db/tests/number-refresh.test.ts. What is
 * asserted here is the job's own contract: it records the call as usage keyed
 * on the job id, it writes nothing when the read fails, and it holds no company
 * scope while Meta is answering.
 */

const findManyIntegrations = vi.fn();
const applyNumberRefresh =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      integrationId: string,
      fetched: unknown[],
      now: Date,
    ) => Promise<{ refreshed: number; added: number; missing: number; restored: number }>
  >();
const recordUsage =
  vi.fn<
    (db: unknown, companyId: string, input: { kind: string; dedupeKey: string }) => Promise<unknown>
  >();
const fetchWhatsAppNumbers = vi.fn();

let openScopes = 0;
const scopesOpenDuringGraphCall: number[] = [];

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, callback: (db: unknown, id: string) => unknown) => {
    openScopes++;
    try {
      return await callback({ integration: { findMany: findManyIntegrations } }, companyId);
    } finally {
      openScopes--;
    }
  },
  applyNumberRefresh,
  recordUsage,
}));

vi.mock("@whatsapp-os/core/whatsapp", () => ({
  fetchWhatsAppNumbers: (secrets: Record<string, string>) => {
    scopesOpenDuringGraphCall.push(openScopes);
    return fetchWhatsAppNumbers(secrets);
  },
}));

vi.mock("@whatsapp-os/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/core")>()),
  decrypt: (ciphertext: string) => `plain:${ciphertext}`,
  secretAad: () => "aad",
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

const { handleWhatsAppNumbersRefresh } = await import("../src/jobs/whatsapp-numbers.ts");

const INTEGRATION = {
  id: "int-1",
  secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }],
};

const NUMBERS = [{ phoneNumberId: "pn-1", status: "CONNECTED" }];

beforeEach(() => {
  for (const mock of [
    findManyIntegrations,
    applyNumberRefresh,
    recordUsage,
    fetchWhatsAppNumbers,
  ]) {
    mock.mockReset();
  }

  scopesOpenDuringGraphCall.length = 0;
  openScopes = 0;

  findManyIntegrations.mockResolvedValue([INTEGRATION]);
  applyNumberRefresh.mockResolvedValue({
    refreshed: 1,
    added: 0,
    missing: 0,
    restored: 0,
  });
  recordUsage.mockResolvedValue({});
  fetchWhatsAppNumbers.mockResolvedValue({ ok: true, numbers: NUMBERS });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a successful refresh", () => {
  it("writes what Meta returned and records the call once per job", async () => {
    const result = await handleWhatsAppNumbersRefresh(
      { companyId: "c1" },
      "job-42",
    );

    expect(result).toEqual({ integrations: 1, refreshed: 1, missing: 0 });
    expect(applyNumberRefresh.mock.calls[0]![3]).toEqual(NUMBERS);

    /*
     * The job id, not a timestamp. All five attempts carry the same id, so one
     * Graph call is charged once however many attempts it took to record - the
     * pattern integration.verify established.
     */
    const usage = recordUsage.mock.calls[0]![2];
    expect(usage.kind).toBe("whatsapp.numbers.refresh");
    expect(usage.dedupeKey).toContain("job-42");
  });

  it("never holds a company scope while Meta is answering", async () => {
    await handleWhatsAppNumbersRefresh({ companyId: "c1" }, "job-42");

    expect(scopesOpenDuringGraphCall).toEqual([0]);
  });
});

describe("a Graph call that fails", () => {
  it("writes nothing at all, rather than marking every number missing", async () => {
    fetchWhatsAppNumbers.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Timed out after 10000ms",
    });

    /*
     * The mistake this guards against is the expensive one. A failed read says
     * nothing about which numbers exist, and passing an empty list to
     * applyNumberRefresh would mark every number the company has as missing
     * because one call timed out.
     */
    await expect(
      handleWhatsAppNumbersRefresh({ companyId: "c1" }, "job-42"),
    ).rejects.toThrow(/Could not read numbers/);

    expect(applyNumberRefresh).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe("a company with no WhatsApp integration", () => {
  it("does nothing and calls nobody", async () => {
    findManyIntegrations.mockResolvedValue([]);

    const result = await handleWhatsAppNumbersRefresh({ companyId: "c1" }, "job-42");

    expect(result).toEqual({ integrations: 0, refreshed: 0, missing: 0 });
    expect(fetchWhatsAppNumbers).not.toHaveBeenCalled();
  });
});
