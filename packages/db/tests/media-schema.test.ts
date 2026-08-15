import { beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import {
  ownerClient,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The guarantees around stored media bytes.
 *
 * These matter more than most schema tests because CHECK constraints are
 * invisible to Prisma: they exist only in the migration, `migrate diff` does
 * not report their absence, and schema.prisma cannot express them. If somebody
 * drops one, nothing else in the toolchain notices. This file is the notice.
 *
 * Constraints, not policies - none of these would fail with row-level security
 * switched off, which is why they are here and not in rls-isolation.test.ts.
 */

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

async function store(
  company: SeededCompany,
  input: {
    sha256: string;
    bytes?: Uint8Array<ArrayBuffer>;
    byteSize?: number;
    state?: "STORED" | "SKIPPED";
  },
): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    await db.whatsAppMedia.create({
      data: {
        companyId,
        sha256: input.sha256,
        mimeType: "image/jpeg",
        byteSize: input.byteSize ?? input.bytes?.byteLength ?? 0,
        state: input.state ?? "STORED",
        bytes: input.bytes ?? null,
      },
    });
  });
}

describe("the size cap", () => {
  it("accepts a file at the limit", async () => {
    const bytes = new Uint8Array(MAX_MEDIA_BYTES).fill(1);

    await expect(store(alpha, { sha256: "at-limit", bytes })).resolves.toBeUndefined();
  });

  it("refuses one byte more, whatever the caller believes", async () => {
    /*
     * The backstop. The real cap is enforced during the download, by aborting
     * the fetch once the running byte count crosses the limit - so a 200 MB
     * response is never resident. This is the check that does not depend on
     * that having happened, in the same spirit as reading magic bytes rather
     * than trusting a file extension.
     */
    const bytes = new Uint8Array(MAX_MEDIA_BYTES + 1).fill(1);

    await expect(store(alpha, { sha256: "over-limit", bytes })).rejects.toThrow(
      /whatsapp_media_bytes_within_cap|constraint/i,
    );
  });

  it("records an oversized file as skipped, with its real size and no bytes", async () => {
    /*
     * The expected path for something too large, and not an error: the thread
     * renders "6.2 MB, not stored", the webhook that carried it still succeeds,
     * and nothing retries. byte_size is Meta's number, which is why the cap
     * constraint is on the bytes and not on byte_size.
     */
    await expect(
      store(alpha, { sha256: "huge", byteSize: 200_000_000, state: "SKIPPED" }),
    ).resolves.toBeUndefined();
  });
});

describe("byte_size cannot lie about the bytes", () => {
  it("refuses a size that disagrees with the content", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO whatsapp_media
            (id, company_id, sha256, mime_type, byte_size, state, bytes, updated_at)
          VALUES ('liar', ${alpha.id}, 'mismatch', 'image/jpeg', 999, 'STORED', '\\x0102030405'::bytea, now())`,
      ),
    ).rejects.toThrow(/whatsapp_media_byte_size_matches|constraint/i);
  });

  it("refuses a negative size", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO whatsapp_media
            (id, company_id, sha256, mime_type, byte_size, state, updated_at)
          VALUES ('negative', ${alpha.id}, 'neg', 'image/jpeg', -1, 'SKIPPED', now())`,
      ),
    ).rejects.toThrow(/whatsapp_media_byte_size_non_negative|constraint/i);
  });
});

describe("dedupe", () => {
  it("stores one row however many messages carry the same file", async () => {
    await store(alpha, { sha256: "same-image", bytes: new TextEncoder().encode("abc") });

    await expect(
      store(alpha, { sha256: "same-image", bytes: new TextEncoder().encode("abc") }),
    ).rejects.toThrow(/unique/i);
  });

  it("never shares a row between two companies", async () => {
    /*
     * Global dedupe is the obvious optimisation and the reason to refuse it is
     * tenancy, not storage: it would make one company's cost depend on
     * another's traffic, produce a row two companies jointly own, and let a
     * company learn from an insert that another tenant already holds a file.
     */
    await store(alpha, { sha256: "same-image", bytes: new TextEncoder().encode("abc") });

    await expect(
      store(beta, { sha256: "same-image", bytes: new TextEncoder().encode("abc") }),
    ).resolves.toBeUndefined();
  });
});

describe("column storage", () => {
  it("keeps the bytes uncompressed and out of line", async () => {
    /*
     * STORAGE EXTERNAL, asserted from the catalog because it cannot be
     * expressed in schema.prisma and would otherwise be a line in a migration
     * nobody reads again.
     *
     * It is load-bearing rather than a tuning choice: the read path slices this
     * column with substring() to stream it, and under the default EXTENDED the
     * value is compressed, so every slice decompresses from the start and the
     * streaming quietly becomes a full read.
     */
    const owner = ownerClient();
    try {
      const { rows } = await owner.query<{ attstorage: string }>(
        `SELECT a.attstorage
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = 'whatsapp_media' AND a.attname = 'bytes'`,
      );

      expect(rows[0]?.attstorage, "bytes is not STORAGE EXTERNAL").toBe("e");
    } finally {
      await owner.end();
    }
  });
});
