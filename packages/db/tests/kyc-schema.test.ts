import { beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import {
  ownerClient,
  seedCompany,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The guarantees around a stored KYC document.
 *
 * The same reasoning as media-schema.test.ts, and it applies harder here.
 * CHECK constraints are invisible to Prisma - they exist only in the migration,
 * `migrate diff` does not report their absence, and schema.prisma cannot
 * express them. If somebody drops one, nothing else in the toolchain notices.
 *
 * What is under them is the most sensitive data this system holds, and two of
 * the three constraints are the last line of a check the upload path also
 * makes. That duplication is the point: a second upload path written later
 * inherits these without knowing they exist.
 *
 * Constraints, not policies - none of these would fail with row-level security
 * switched off, which is why they live here and not in rls-isolation.test.ts.
 */

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** The first five bytes of every PDF ever written. */
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

/** A PDF as far as every check in this file is concerned. */
function pdfOf(totalBytes: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(PDF_MAGIC.slice(0, Math.min(5, totalBytes)));
  return bytes;
}

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

async function file(
  company: SeededCompany,
  input: {
    kind?: "GST" | "PAN" | "AADHAAR";
    bytes: Uint8Array<ArrayBuffer>;
    byteSize?: number;
    sha256?: string;
  },
): Promise<string> {
  return withCompany(company.id, async (db, companyId) => {
    const row = await db.kycDocument.create({
      data: {
        companyId,
        kind: input.kind ?? "GST",
        bytes: input.bytes,
        byteSize: input.byteSize ?? input.bytes.byteLength,
        sha256: input.sha256 ?? "sha-placeholder",
        mimeType: "application/pdf",
        originalFilename: "gst-certificate.pdf",
      },
      select: { id: true },
    });
    return row.id;
  });
}

describe("the size cap", () => {
  it("accepts a file at the limit", async () => {
    await expect(file(alpha, { bytes: pdfOf(MAX_DOCUMENT_BYTES) })).resolves.toBeTruthy();
  });

  it("refuses one byte more, whatever the caller believes", async () => {
    /*
     * The backstop. The real cap is enforced while the upload streams, by
     * abandoning the read once the running byte count crosses the limit - so a
     * 200 MB body is never resident. This is the check that does not depend on
     * that having happened.
     */
    await expect(file(alpha, { bytes: pdfOf(MAX_DOCUMENT_BYTES + 1) })).rejects.toThrow(
      /kyc_documents_bytes_within_cap|constraint/i,
    );
  });
});

describe("the file is a PDF because its first bytes say so", () => {
  it("accepts one that opens with %PDF-", async () => {
    await expect(file(alpha, { bytes: pdfOf(2048) })).resolves.toBeTruthy();
  });

  it("refuses one that does not, however it is named or typed", async () => {
    /*
     * The row claims application/pdf and gst-certificate.pdf, because both of
     * those come from whoever is uploading and neither is evidence. Only the
     * content is.
     */
    const notPdf = new TextEncoder().encode(
      "<!doctype html><script>alert(1)</script>",
    ) as Uint8Array<ArrayBuffer>;

    await expect(file(alpha, { bytes: notPdf })).rejects.toThrow(
      /kyc_documents_bytes_are_pdf|constraint/i,
    );
  });

  it("refuses an empty file, without needing a rule of its own", async () => {
    /* substring() of nothing is not '%PDF-', so the magic-byte check already
       covers the zero-length case. Asserted so that "no non-empty constraint"
       reads as a decision rather than an omission. */
    await expect(
      file(alpha, { bytes: new Uint8Array(0) as Uint8Array<ArrayBuffer> }),
    ).rejects.toThrow(/kyc_documents_bytes_are_pdf|constraint/i);
  });

  it("refuses a PDF header four bytes in", async () => {
    /* Prefixed rather than truncated: %PDF- appearing later in the file is not
       a PDF, and a check written with position() or LIKE '%…' would accept it. */
    const late = new Uint8Array(64);
    late.set(PDF_MAGIC, 4);

    await expect(
      file(alpha, { bytes: late as Uint8Array<ArrayBuffer> }),
    ).rejects.toThrow(/kyc_documents_bytes_are_pdf|constraint/i);
  });
});

describe("byte_size cannot lie about the bytes", () => {
  it("refuses a size that disagrees with the content", async () => {
    /*
     * This is what makes it safe for the download route to send byte_size as
     * Content-Length. A row that overstated its length would produce a
     * response that stalls until the client gives up.
     */
    await expect(file(alpha, { bytes: pdfOf(512), byteSize: 999 })).rejects.toThrow(
      /kyc_documents_byte_size_matches|constraint/i,
    );
  });
});

describe("append-only", () => {
  it("keeps every upload of the same kind, rather than replacing", async () => {
    /*
     * The property the whole table exists for: what an operator approved has to
     * survive the tenant replacing the file afterwards.
     */
    const first = await file(alpha, { kind: "PAN", bytes: pdfOf(128), sha256: "one" });
    const second = await file(alpha, { kind: "PAN", bytes: pdfOf(256), sha256: "two" });

    expect(second).not.toBe(first);

    const rows = await withCompany(alpha.id, (db) =>
      db.kycDocument.findMany({ where: { kind: "PAN" }, select: { id: true } }),
    );

    expect(rows).toHaveLength(2);
  });

  it("lets two companies file identical bytes", async () => {
    /*
     * There is no unique on sha256 of any kind, and that is deliberate in both
     * directions. Across companies it would make one tenant's upload fail
     * because of another's - an existence oracle over identity documents. And
     * within one company it would refuse a re-upload of the very file an
     * operator asked to have sent again.
     */
    const bytes = pdfOf(300);

    await file(alpha, { bytes, sha256: "identical" });
    await expect(file(beta, { bytes, sha256: "identical" })).resolves.toBeTruthy();
    await expect(file(alpha, { bytes, sha256: "identical" })).resolves.toBeTruthy();
  });
});

describe("column storage", () => {
  it("keeps the bytes uncompressed and out of line", async () => {
    /*
     * STORAGE EXTERNAL, asserted from the catalog because schema.prisma cannot
     * express it. Load-bearing rather than a tuning choice: the download route
     * slices this column with substring() to stream it, and under the default
     * EXTENDED the value is compressed, so every slice decompresses from the
     * start and the streaming quietly becomes a full read.
     */
    const owner = ownerClient();
    try {
      const { rows } = await owner.query<{ attstorage: string }>(
        `SELECT a.attstorage
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = 'kyc_documents' AND a.attname = 'bytes'`,
      );

      expect(rows[0]?.attstorage, "bytes is not STORAGE EXTERNAL").toBe("e");
    } finally {
      await owner.end();
    }
  });
});
