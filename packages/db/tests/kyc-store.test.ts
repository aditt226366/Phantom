import { beforeEach, describe, expect, it } from "vitest";
import {
  currentKycDocuments,
  listKycDocuments,
  putKycDocument,
  readKycDocument,
  statKycDocument,
  withCompany,
  type KycKind,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Reading an append-only table, which is the part with no precedent.
 *
 * The storage half copies media-store.ts and is covered by its own tests and
 * by kyc-schema.test.ts. What is new is that there is no "the GST document"
 * row - there is the newest row of kind GST - and every surface in the phase
 * asks that question. If this ordering is wrong, an operator approves one file
 * and the gate opens on another.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

/** A PDF as far as the CHECK constraint is concerned, of a given length. */
function pdf(size: number, fill = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.fill(fill);
  bytes.set(new TextEncoder().encode("%PDF-"));
  return bytes;
}

async function file(
  company: SeededCompany,
  kind: KycKind,
  input: { size?: number; fill?: number; name?: string; sha256?: string } = {},
): Promise<string> {
  return withCompany(company.id, (db, companyId) =>
    putKycDocument(db, companyId, {
      kind,
      bytes: pdf(input.size ?? 64, input.fill ?? 0),
      sha256: input.sha256 ?? `${kind}-${input.name ?? "sha"}`,
      mimeType: "application/pdf",
      originalFilename: input.name ?? `${kind.toLowerCase()}.pdf`,
    }),
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe("the current state of a kind", () => {
  it("is null for every kind before anything is filed", async () => {
    const current = await withCompany(alpha.id, (db, companyId) =>
      currentKycDocuments(db, companyId),
    );

    expect(current).toEqual({ GST: null, PAN: null, AADHAAR: null });
  });

  it("is the newest row, not the first", async () => {
    /*
     * The assertion the whole table is shaped for. A re-upload after a
     * rejection supersedes; if this returned the older row, a tenant would fix
     * a refused document and watch the refusal stay on screen.
     */
    const first = await file(alpha, "GST", { name: "old.pdf", sha256: "gst-1" });
    const second = await file(alpha, "GST", { name: "new.pdf", sha256: "gst-2" });

    const current = await withCompany(alpha.id, (db, companyId) =>
      currentKycDocuments(db, companyId),
    );

    expect(current.GST?.id).toBe(second);
    expect(current.GST?.id).not.toBe(first);
    expect(current.GST?.originalFilename).toBe("new.pdf");
  });

  it("keeps the kinds independent", async () => {
    await file(alpha, "GST");
    await file(alpha, "AADHAAR");

    const current = await withCompany(alpha.id, (db, companyId) =>
      currentKycDocuments(db, companyId),
    );

    expect(current.GST).not.toBeNull();
    expect(current.AADHAAR).not.toBeNull();
    expect(current.PAN, "PAN was never filed").toBeNull();
  });

  it("does not read another company's newest row", async () => {
    await file(beta, "PAN", { name: "beta.pdf" });

    const current = await withCompany(alpha.id, (db, companyId) =>
      currentKycDocuments(db, companyId),
    );

    expect(current.PAN).toBeNull();
  });

  it("never carries the bytes", async () => {
    /*
     * The select is column by column so that adding a column to the table
     * cannot widen it. This asserts the consequence rather than the reason -
     * a stat that grew a `bytes` key would put an Aadhaar card into a server
     * component's props, where it would be serialised to the client.
     */
    await file(alpha, "AADHAAR");

    const current = await withCompany(alpha.id, (db, companyId) =>
      currentKycDocuments(db, companyId),
    );

    expect(Object.keys(current.AADHAAR ?? {})).not.toContain("bytes");
  });
});

describe("the full history", () => {
  it("keeps every attempt, newest first", async () => {
    await file(alpha, "GST", { sha256: "one" });
    await file(alpha, "GST", { sha256: "two" });
    await file(alpha, "PAN", { sha256: "three" });

    const all = await withCompany(alpha.id, (db, companyId) =>
      listKycDocuments(db, companyId),
    );

    expect(all).toHaveLength(3);
    expect(all[0]?.sha256, "not ordered newest first").toBe("three");
  });
});

describe("reading one by id", () => {
  it("returns null for another company's document", async () => {
    /* Rule 6, at the layer that decides it. The route renders 404 for null,
       and a verdict carrying a reason would confirm the id exists. */
    const id = await file(beta, "GST");

    const found = await withCompany(alpha.id, (db, companyId) =>
      statKycDocument(db, companyId, id),
    );

    expect(found).toBeNull();
  });

  it("returns null for an id that does not exist", async () => {
    const found = await withCompany(alpha.id, (db, companyId) =>
      statKycDocument(db, companyId, "c000000000000000000000000"),
    );

    expect(found).toBeNull();
  });
});

describe("the bytes", () => {
  it("come back exactly as filed, in the single-chunk case", async () => {
    const id = await file(alpha, "GST", { size: 1024, fill: 7 });

    const stream = await readKycDocument(alpha.id, id);
    expect(stream).not.toBeNull();

    const bytes = await drain(stream!);

    expect(bytes.byteLength).toBe(1024);
    expect(bytes).toEqual(pdf(1024, 7));
  });

  it("come back exactly as filed across several chunks", async () => {
    /*
     * Over CHUNK_BYTES, so the loop runs and the offset arithmetic is
     * exercised. Postgres substring is 1-based and the offset is not, which is
     * an off-by-one that would corrupt every document larger than one chunk
     * while leaving every small one perfect - so a fixture under 512 KiB
     * proves nothing about this path.
     */
    const size = 512 * 1024 + 4096;
    const id = await file(alpha, "PAN", { size, fill: 3 });

    const stream = await readKycDocument(alpha.id, id);
    const bytes = await drain(stream!);

    expect(bytes.byteLength).toBe(size);
    expect(bytes).toEqual(pdf(size, 3));
  });

  it("are refused to another company", async () => {
    /*
     * The assertion behind the download route returning 404. The id is real
     * and correct; the scope is what refuses it.
     */
    const id = await file(beta, "AADHAAR");

    expect(await readKycDocument(alpha.id, id)).toBeNull();
  });
});
