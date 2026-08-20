import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the media job decides, and in what order.
 *
 * The store itself is proved against a real database in
 * packages/db/tests/media-store.test.ts, and the two Graph calls against a
 * stubbed fetch in packages/core/tests/whatsapp-media.test.ts. What is left
 * here is this job's own reasoning: when it skips the download entirely, when
 * it records a file it refuses to keep, and the rule that no company scope is
 * ever open while Meta is being called.
 */

const BYTES = new Uint8Array(1024).fill(3);
const SHA = createHash("sha256").update(BYTES).digest("hex");

const findFirstMessage = vi.fn();
const findFirstMedia = vi.fn();
const updateMessage = vi.fn(async () => ({}));
/* Typed to the shape the job calls, so the assertions on the put input below
   are checked rather than reaching into an inferred empty tuple. */
const put = vi.fn<
  (
    db: unknown,
    companyId: string,
    input: Record<string, unknown>,
  ) => Promise<{ key: string; deduped: boolean }>
>(async () => ({ key: "media-row-1", deduped: false }));
const fetchWhatsAppMediaMetadata = vi.fn();
const downloadWhatsAppMedia = vi.fn();

/** Rises while a company scope is open, so a call made inside one is visible. */
let openScopes = 0;
const scopesOpenDuringGraphCalls: number[] = [];

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, callback: (db: unknown, id: string) => unknown) => {
    openScopes++;
    try {
      return await callback(
        {
          message: { findFirst: findFirstMessage, update: updateMessage },
          whatsAppMedia: { findFirst: findFirstMedia },
        },
        companyId,
      );
    } finally {
      openScopes--;
    }
  },
  mediaStore: { put },
}));

vi.mock("@whatsapp-os/core/whatsapp", () => ({
  MAX_MEDIA_BYTES: 5 * 1024 * 1024,
  fetchWhatsAppMediaMetadata: (...args: unknown[]) => {
    scopesOpenDuringGraphCalls.push(openScopes);
    return fetchWhatsAppMediaMetadata(...args);
  },
  downloadWhatsAppMedia: (...args: unknown[]) => {
    scopesOpenDuringGraphCalls.push(openScopes);
    return downloadWhatsAppMedia(...args);
  },
}));

/*
 * Partial: the worker's env module imports loadRootEnv from this barrel, so
 * replacing the whole thing takes the process down before a test runs. Only
 * the two crypto helpers are stubbed, because sealing a real ciphertext to
 * exercise them would be testing the vault, which has its own suite.
 */
vi.mock("@whatsapp-os/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/core")>()),
  decrypt: (ciphertext: string) => `plain:${ciphertext}`,
  secretAad: () => "aad",
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

const { handleWhatsAppMediaFetch } = await import("../src/jobs/whatsapp-media.ts");

const JOB = { companyId: "c1", messageId: "m1", metaMediaId: "meta-9" };

function messageRow(over: { mediaId?: string | null } = {}) {
  return {
    id: "m1",
    mediaId: over.mediaId ?? null,
    conversation: {
      whatsappNumber: {
        integrationId: "int-1",
        integration: {
          secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }],
        },
      },
    },
  };
}

function metadata(over: Partial<{ fileSize: number; sha256: string }> = {}) {
  return {
    ok: true as const,
    metadata: {
      id: "meta-9",
      sha256: over.sha256 ?? SHA,
      mimeType: "image/jpeg",
      fileSize: over.fileSize ?? BYTES.byteLength,
      url: "https://lookaside.example/abc",
    },
  };
}

beforeEach(() => {
  for (const mock of [
    findFirstMessage,
    findFirstMedia,
    updateMessage,
    put,
    fetchWhatsAppMediaMetadata,
    downloadWhatsAppMedia,
  ]) {
    mock.mockReset();
  }

  scopesOpenDuringGraphCalls.length = 0;
  openScopes = 0;

  updateMessage.mockResolvedValue({});
  put.mockResolvedValue({ key: "media-row-1", deduped: false });
  findFirstMedia.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an ordinary media message", () => {
  it("stores the bytes and links them to the message", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata());
    downloadWhatsAppMedia.mockResolvedValue({
      ok: true,
      bytes: BYTES,
      byteSize: BYTES.byteLength,
    });

    const result = await handleWhatsAppMediaFetch(JOB);

    expect(result).toEqual({ result: "stored", byteSize: BYTES.byteLength });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![2]).toMatchObject({
      sha256: SHA,
      mimeType: "image/jpeg",
      byteSize: BYTES.byteLength,
      bytes: BYTES,
    });

    /* The link is what makes the file reachable from the thread. */
    expect(updateMessage).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { mediaId: "media-row-1" },
    });
  });

  it("never holds a company scope while Meta is being called", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata());
    downloadWhatsAppMedia.mockResolvedValue({
      ok: true,
      bytes: BYTES,
      byteSize: BYTES.byteLength,
    });

    await handleWhatsAppMediaFetch(JOB);

    /*
     * A media download is the longest call in this system and a scope holds a
     * pooled connection that Prisma abandons after five seconds. Both Graph
     * calls must therefore happen with nothing open - asserted rather than
     * arranged, because the natural way to write this job is to do the read,
     * the call and the write in one scope, and it would work in every test
     * that did not measure it.
     */
    expect(scopesOpenDuringGraphCalls).toEqual([0, 0]);
  });
});

describe("a file we already hold", () => {
  it("links the existing row and never downloads", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata());
    findFirstMedia.mockResolvedValue({ id: "media-existing" });

    const result = await handleWhatsAppMediaFetch(JOB);

    expect(result.result).toBe("deduped");
    /* The metadata call carries the hash, so the same photo forwarded fifty
       times costs fifty metadata calls and one transfer. */
    expect(downloadWhatsAppMedia).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(updateMessage).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { mediaId: "media-existing" },
    });
  });
});

describe("a file that is too big", () => {
  it("records its size without transferring it, when Meta says so up front", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata({ fileSize: 9_000_000 }));

    const result = await handleWhatsAppMediaFetch(JOB);

    expect(result).toEqual({ result: "too_large", byteSize: 9_000_000 });
    expect(downloadWhatsAppMedia).not.toHaveBeenCalled();

    /* A row with a size and no bytes, so the thread can say "8.6 MB, not
       stored" rather than showing an empty message. */
    expect(put.mock.calls[0]![2]).toMatchObject({
      byteSize: 9_000_000,
      skippedReason: "over_max_size",
    });
    expect(put.mock.calls[0]![2]).not.toHaveProperty("bytes");
  });

  it("records it on the real byte count when file_size understated it", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata({ fileSize: 1024 }));
    downloadWhatsAppMedia.mockResolvedValue({
      ok: false,
      kind: "too_large",
      byteSize: 6_000_000,
    });

    const result = await handleWhatsAppMediaFetch(JOB);

    /* file_size is a claim. The cap that decides is the one counting bytes. */
    expect(result).toEqual({ result: "too_large", byteSize: 6_000_000 });
    expect(put.mock.calls[0]![2]).toMatchObject({
      byteSize: 6_000_000,
      skippedReason: "over_max_size",
    });
  });
});

describe("bytes that are not what Meta described", () => {
  it("refuses to store them under Meta's hash", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue(metadata({ sha256: "f".repeat(64) }));
    downloadWhatsAppMedia.mockResolvedValue({
      ok: true,
      bytes: BYTES,
      byteSize: BYTES.byteLength,
    });

    /*
     * The media table deduplicates on the hash, so bytes stored under one they
     * do not match would be handed back later for a different file's key.
     * Throwing retries the transfer, which is the right response to corruption.
     */
    await expect(handleWhatsAppMediaFetch(JOB)).rejects.toThrow(/did not match the hash/);

    expect(put).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });
});

describe("jobs with nothing to do", () => {
  it("does nothing for a message that no longer exists", async () => {
    findFirstMessage.mockResolvedValue(null);

    const result = await handleWhatsAppMediaFetch(JOB);

    expect(result.result).toBe("unknown_message");
    expect(fetchWhatsAppMediaMetadata).not.toHaveBeenCalled();
  });

  it("does nothing for a message whose bytes are already linked", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ mediaId: "media-row-1" }));

    const result = await handleWhatsAppMediaFetch(JOB);

    expect(result.result).toBe("already_stored");
    expect(fetchWhatsAppMediaMetadata).not.toHaveBeenCalled();
  });
});

describe("a Graph call that fails", () => {
  it("throws, so the job retries and a permanent failure is visible", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    fetchWhatsAppMediaMetadata.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Timed out after 10000ms",
    });

    await expect(handleWhatsAppMediaFetch(JOB)).rejects.toThrow(/Could not read media/);
    expect(put).not.toHaveBeenCalled();
  });
});
