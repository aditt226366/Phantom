import { beforeEach, describe, expect, it } from "vitest";
import { mediaStore, withCompany } from "../src/index.ts";
import {
  seedCompany,
  superuserClient,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The store, not the schema.
 *
 * media-schema.test.ts asserts what the table refuses. This asserts what the
 * two halves of the interface do with it - including the case that only exists
 * because get() streams: the row disappearing after the response has started.
 */

const CHUNK_BYTES = 512 * 1024;

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

/** Deterministic bytes, so a wrong offset shows up as wrong content. */
function pattern(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

async function store(
  company: SeededCompany,
  sha256: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const { key } = await withCompany(company.id, (db, companyId) =>
    mediaStore.put(db, companyId, {
      sha256,
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      byteSize: bytes.byteLength,
      bytes,
    }),
  );
  return key;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

describe("put", () => {
  it("stores bytes and hands back a key", async () => {
    const key = await store(alpha, "sha-one", pattern(64));

    const meta = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.stat(db, companyId, key),
    );

    expect(meta).toMatchObject({
      key,
      sha256: "sha-one",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      byteSize: 64,
      state: "STORED",
      skippedReason: null,
    });
  });

  it("reports the second put of the same file as deduped", async () => {
    /*
     * What the worker uses to skip a download it has not started: Meta returns
     * the sha256 from the metadata call, before any transfer.
     */
    const first = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.put(db, companyId, {
        sha256: "sha-same",
        mimeType: "image/jpeg",
        fileName: null,
        byteSize: 3,
        bytes: pattern(3),
      }),
    );
    const second = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.put(db, companyId, {
        sha256: "sha-same",
        mimeType: "image/jpeg",
        fileName: null,
        byteSize: 3,
        bytes: pattern(3),
      }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.key).toBe(first.key);
  });

  it("records a skip without bytes", async () => {
    const { key } = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.put(db, companyId, {
        sha256: "sha-huge",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        byteSize: 200_000_000,
        skippedReason: "over_max_size",
      }),
    );

    const meta = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.stat(db, companyId, key),
    );

    expect(meta).toMatchObject({
      state: "SKIPPED",
      skippedReason: "over_max_size",
      byteSize: 200_000_000,
    });
  });
});

describe("stat", () => {
  it("does not see another company's media", async () => {
    const key = await store(alpha, "sha-alpha", pattern(16));

    const seen = await withCompany(beta.id, (db, companyId) =>
      mediaStore.stat(db, companyId, key),
    );

    /* Null, not a throw. The route turns this into 404, never 403. */
    expect(seen).toBeNull();
  });
});

describe("get", () => {
  it("returns a file smaller than one chunk in a single read", async () => {
    const bytes = pattern(1024);
    const key = await store(alpha, "sha-small", bytes);

    const stream = await mediaStore.get(alpha.id, key);
    expect(stream).not.toBeNull();

    expect(await drain(stream!)).toEqual(bytes);
  });

  it("reassembles a file spanning several chunks, in order", async () => {
    /*
     * Two and a bit chunks, so the loop runs three times and the last read is
     * short by design. A wrong offset or an off-by-one on substring's 1-based
     * indexing shows up as wrong content rather than a wrong length, which is
     * why the bytes are a pattern and not zeroes.
     */
    const bytes = pattern(CHUNK_BYTES * 2 + 12_345);
    const key = await store(alpha, "sha-big", bytes);

    const stream = await mediaStore.get(alpha.id, key);
    const got = await drain(stream!);

    expect(got.byteLength).toBe(bytes.byteLength);
    expect(got).toEqual(bytes);
  });

  it("returns null for another company's key", async () => {
    const key = await store(alpha, "sha-alpha", pattern(32));

    expect(await mediaStore.get(beta.id, key)).toBeNull();
  });

  it("returns null when the bytes were never stored", async () => {
    const { key } = await withCompany(alpha.id, (db, companyId) =>
      mediaStore.put(db, companyId, {
        sha256: "sha-skipped",
        mimeType: "video/mp4",
        fileName: null,
        byteSize: 9_000_000,
        skippedReason: "over_max_size",
      }),
    );

    expect(await mediaStore.get(alpha.id, key)).toBeNull();
  });

  it("errors rather than truncating when the row vanishes mid-stream", async () => {
    /*
     * The case the streaming signature creates, and the only one where being
     * wrong is silent.
     *
     * By the second chunk the response headers are long gone, including a
     * Content-Length that promised the full file. Ending the stream quietly
     * would hand the client a short file under a 200 - a corrupt image that
     * saves without complaint. Erroring destroys the transfer instead, which
     * the client can at least notice.
     *
     * Deleted through the superuser connection because FORCE ROW LEVEL
     * SECURITY leaves the owner unable to touch the row.
     */
    const bytes = pattern(CHUNK_BYTES * 3);
    const key = await store(alpha, "sha-vanish", bytes);

    const stream = await mediaStore.get(alpha.id, key);
    const reader = stream!.getReader();

    const first = await reader.read();
    expect(first.value?.byteLength).toBe(CHUNK_BYTES);

    const su = superuserClient();
    try {
      await su.query("DELETE FROM whatsapp_media WHERE id = $1", [key]);
    } finally {
      await su.end();
    }

    await expect(reader.read()).rejects.toThrow(/ended after .* of .* bytes/);
  });
});
