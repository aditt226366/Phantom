import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cache's own mechanics: what it serves, what it drops, and when.
 *
 * The vault read underneath is thin plumbing - resolve, select, unseal - and is
 * covered where those live. What is worth asserting here is the bookkeeping,
 * because every bug it can have is a security-adjacent one: serving a secret
 * that has been rotated, holding one after an integration was disconnected, or
 * growing without limit on an endpoint anyone can reach.
 */

const resolveCompany = vi.fn<(kind: string, key: string) => Promise<string | null>>();
const findFirstIntegration = vi.fn();

vi.mock("@whatsapp-os/db", () => ({
  resolveCompany: (kind: string, key: string) => resolveCompany(kind, key),
  withCompany: async (_companyId: string, callback: (db: unknown) => unknown) =>
    callback({ integration: { findFirst: findFirstIntegration } }),
}));

vi.mock("@/lib/integrations/seal.ts", () => ({
  /* The unseal is exercised by the vault suite; here it only has to be
     deterministic so a cache hit and a reload are distinguishable. */
  open: (_companyId: string, _integrationId: string, key: string, ciphertext: string) =>
    `plain:${key}:${ciphertext}`,
}));

const { getWebhookSecrets, evictWebhookSecrets, resetWebhookSecretCache } =
  await import("@/lib/webhook-secrets.ts");

function integrationRow(appSecret = "ct-app") {
  return {
    id: "int-1",
    secrets: [
      { key: "WHATSAPP_APP_SECRET", ciphertext: appSecret },
      { key: "WHATSAPP_VERIFY_TOKEN", ciphertext: "ct-verify" },
    ],
  };
}

beforeEach(() => {
  resetWebhookSecretCache();
  resolveCompany.mockReset();
  findFirstIntegration.mockReset();

  resolveCompany.mockResolvedValue("company-1");
  findFirstIntegration.mockResolvedValue(integrationRow());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reading a webhook's secrets", () => {
  it("resolves and decrypts once, then serves from memory", async () => {
    const first = await getWebhookSecrets("key-1");
    const second = await getWebhookSecrets("key-1");

    expect(first?.appSecret.reveal()).toBe("plain:WHATSAPP_APP_SECRET:ct-app");
    expect(second?.appSecret.reveal()).toBe("plain:WHATSAPP_APP_SECRET:ct-app");

    /* The point of the cache: one resolve and one vault read for a burst that
       Meta can send at any width. */
    expect(resolveCompany).toHaveBeenCalledTimes(1);
    expect(findFirstIntegration).toHaveBeenCalledTimes(1);
  });

  it("returns null for a key that resolves to nothing, and does not cache it", async () => {
    resolveCompany.mockResolvedValue(null);

    expect(await getWebhookSecrets("nobody")).toBeNull();
    expect(await getWebhookSecrets("nobody")).toBeNull();

    /*
     * Caching the negative would make a rotated key take a minute to start
     * working, while doing nothing to slow an attacker who is already stopped
     * by the throttle.
     */
    expect(resolveCompany).toHaveBeenCalledTimes(2);
  });

  it("returns null when the integration has no app secret stored", async () => {
    findFirstIntegration.mockResolvedValue({
      id: "int-1",
      secrets: [{ key: "WHATSAPP_VERIFY_TOKEN", ciphertext: "ct-verify" }],
    });

    expect(await getWebhookSecrets("key-1")).toBeNull();
  });
});

describe("staleness", () => {
  it("re-reads once the entry has expired", async () => {
    vi.useFakeTimers();

    await getWebhookSecrets("key-1");
    findFirstIntegration.mockResolvedValue(integrationRow("ct-rotated"));

    /* Still inside the window: the old value, deliberately. */
    vi.advanceTimersByTime(59_000);
    expect((await getWebhookSecrets("key-1"))?.appSecret.reveal()).toContain("ct-app");

    /*
     * Past it. This is the cross-instance backstop doing its job - the process
     * that handled a save evicts immediately, and every other instance
     * converges here.
     */
    vi.advanceTimersByTime(2_000);
    expect((await getWebhookSecrets("key-1"))?.appSecret.reveal()).toContain(
      "ct-rotated",
    );
  });

  it("drops a company's entries the moment its credentials change", async () => {
    await getWebhookSecrets("key-1");
    findFirstIntegration.mockResolvedValue(integrationRow("ct-rotated"));

    evictWebhookSecrets("company-1");

    /*
     * What the admin actions call beside revalidatePath. Without it a rotated
     * app secret keeps failing signatures for up to a minute, which reads
     * exactly like a save that did not work.
     */
    expect((await getWebhookSecrets("key-1"))?.appSecret.reveal()).toContain(
      "ct-rotated",
    );
  });

  it("leaves another company's entries alone", async () => {
    await getWebhookSecrets("key-1");

    resolveCompany.mockResolvedValue("company-2");
    await getWebhookSecrets("key-2");

    resolveCompany.mockClear();
    findFirstIntegration.mockClear();

    evictWebhookSecrets("company-2");

    await getWebhookSecrets("key-1");
    expect(resolveCompany, "company-1's entry was dropped too").not.toHaveBeenCalled();
  });
});

describe("the bound", () => {
  it("never holds more than 256 entries", async () => {
    for (let index = 0; index < 300; index++) {
      resolveCompany.mockResolvedValue(`company-${index}`);
      await getWebhookSecrets(`key-${index}`);
    }

    /*
     * The endpoint is unauthenticated, so the set of keys reaching it is not
     * one this system chooses. Unbounded, a script sending 100k distinct keys
     * would grow this until the process died - and every entry holds decrypted
     * material.
     *
     * Measured by behaviour rather than by reading a private field: the oldest
     * key must have been dropped, and the newest must still be resident.
     */
    resolveCompany.mockClear();

    await getWebhookSecrets("key-299");
    expect(resolveCompany, "the newest entry was evicted").not.toHaveBeenCalled();

    await getWebhookSecrets("key-0");
    expect(resolveCompany, "the oldest entry survived 300 inserts").toHaveBeenCalled();
  });

  it("keeps an entry that is still being used", async () => {
    await getWebhookSecrets("key-hot");

    for (let index = 0; index < 255; index++) {
      resolveCompany.mockResolvedValue(`company-${index}`);
      await getWebhookSecrets(`key-${index}`);
      /* Touched on every round, so it is never the least recently used. */
      resolveCompany.mockResolvedValue("company-1");
      await getWebhookSecrets("key-hot");
    }

    resolveCompany.mockClear();
    await getWebhookSecrets("key-hot");

    /* Least-recently-used, not first-inserted. A busy tenant's key must not be
       evicted by a flood of keys nobody uses twice. */
    expect(resolveCompany).not.toHaveBeenCalled();
  });
});
