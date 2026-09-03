import { beforeEach, describe, expect, it } from "vitest";

import {
  chunkContentHash,
  deleteDocumentAndOrphanedChunks,
  replaceChunks,
  retrieveChunks,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * One passage, many sources.
 *
 * ---------------------------------------------------------------------------
 * What duplicated chunks cost, which is not storage
 * ---------------------------------------------------------------------------
 *
 * Retrieval is `ORDER BY embedding <=> $q LIMIT k`. Identical text has an
 * identical embedding, so duplicates score EXACTLY the same and arrive together
 * at the top. A top-5 over a paragraph that appears in five documents is one
 * passage occupying five slots - and `retrieveChunks`, `groundingFor`, the
 * /dev/rag harness and the operator all count five. The grounding is thinner
 * than every layer above it believes and nothing reports it.
 *
 * Identical text is ordinary in a knowledge base: a footer repeated across
 * documents, the same page crawled under two URLs, a PDF and its web version
 * both uploaded, a terms section quoted in a FAQ.
 *
 * ---------------------------------------------------------------------------
 * The deletion case is the one that can disclose
 * ---------------------------------------------------------------------------
 *
 * Sharing a chunk means a document's deletion can no longer just cascade. A
 * passage shared with another document must survive; a passage that was only in
 * the deleted document must NOT, or it stays in the index, stays retrievable,
 * and goes on answering customers out of a document the tenant removed - citing
 * a document that no longer exists. Both halves are asserted below, because
 * getting either wrong looks exactly like getting it right from the outside.
 */

let company: SeededCompany;
let baseId: string;

const MODEL = "text-embedding-3-small";

/** Distinct unit vectors, so passages are far apart unless they are identical. */
function axis(index: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0));
}

/** The paragraph two documents will both contain, byte for byte. */
const SHARED = "Refunds are available within 14 days of delivery.";

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("verse-dedupe");

  baseId = await withCompany(company.id, async (db, companyId) => {
    const base = await db.knowledgeBase.create({
      data: {
        companyId,
        name: "Handbook",
        embeddingModel: MODEL,
        embeddingVersion: 1,
      },
      select: { id: true },
    });
    return base.id;
  });
});

async function seedDocument(title: string): Promise<string> {
  return withCompany(company.id, async (db, companyId) => {
    const document = await db.kbDocument.create({
      data: {
        companyId,
        knowledgeBaseId: baseId,
        title,
        kind: "FILE",
        filename: `${title}.pdf`,
        status: "INDEXED",
      },
      select: { id: true },
    });
    return document.id;
  });
}

/** Ingest `contents` as one document's passages, at positions 0..n. */
async function ingest(
  documentId: string,
  contents: readonly string[],
  embeddings?: readonly number[][],
): Promise<number> {
  return withCompany(company.id, (db, companyId) =>
    replaceChunks(db, companyId, {
      knowledgeBaseId: baseId,
      documentId,
      embeddingModel: MODEL,
      embeddingVersion: 1,
      chunks: contents.map((content, index) => ({
        seq: index,
        content,
        tokenCount: 8,
        embedding: embeddings?.[index] ?? axis(index),
      })),
    }),
  );
}

function countChunks(): Promise<number> {
  return withCompany(company.id, async (db, companyId) => {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM kb_chunks
       WHERE company_id = ${companyId} AND knowledge_base_id = ${baseId}
    `;
    return Number(rows[0]!.n);
  });
}

describe("the hash", () => {
  it("agrees with the one Postgres computed in the migration", async () => {
    /*
     * The two implementations that must never diverge. The migration backfilled
     * `encode(sha256(convert_to(content,'UTF8')),'hex')`; every row written
     * since comes from Node's createHash. A mismatch deduplicates nothing and
     * is invisible - both sides stay internally consistent and nothing errors -
     * so it is asserted against the database rather than against a literal.
     */
    const text = "Refunds — 14 days. ₹500 minimum. Ünicode and a tab\there.";

    const fromPostgres = await withCompany(company.id, async (db) => {
      const rows = await db.$queryRaw<Array<{ hash: string }>>`
        SELECT encode(sha256(convert_to(${text}, 'UTF8')), 'hex') AS hash
      `;
      return rows[0]!.hash;
    });

    expect(chunkContentHash(text)).toBe(fromPostgres);
  });

  it("does not normalise, so near-identical text stays two passages", async () => {
    /*
     * The safe direction. Merging on trimmed or case-folded text would be a
     * claim about meaning, and it is unrecoverable: the variant that lost is
     * gone. One trailing space is two chunks.
     */
    const first = await seedDocument("A");
    await ingest(first, [SHARED, `${SHARED} `]);

    expect(await countChunks()).toBe(2);
  });
});

describe("identical text across two documents", () => {
  it("is one chunk, and both documents are sources of it", async () => {
    const terms = await seedDocument("Terms");
    const faq = await seedDocument("FAQ");

    await ingest(terms, [SHARED]);
    await ingest(faq, [SHARED]);

    expect(await countChunks()).toBe(1);

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
      }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.sources.map((source) => source.documentTitle)).toEqual([
      "FAQ",
      "Terms",
    ]);
  });

  it("keeps each document's own position for the same passage", async () => {
    /*
     * Why `seq` had to move off kb_chunks. The same sentence is the first thing
     * in Terms and the fortieth in the Handbook, and a citation that showed one
     * number for both would be wrong for one of them.
     */
    const terms = await seedDocument("Terms");
    const handbook = await seedDocument("Handbook");

    await ingest(terms, [SHARED]);
    await ingest(handbook, ["Something else entirely.", "Filler.", SHARED]);

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
        limit: 5,
      }),
    );

    const shared = found.find((chunk) => chunk.content === SHARED)!;

    expect(
      shared.sources.map((source) => [source.documentTitle, source.seq]),
    ).toEqual([
      ["Handbook", 2],
      ["Terms", 0],
    ]);
  });

  it("gives top-k k DISTINCT passages rather than k copies of one", async () => {
    /*
     * THE assertion this change exists for.
     *
     * Five documents each containing the same paragraph plus one of their own.
     * Before deduplication, a top-5 against that paragraph was five rows of the
     * same sentence: one passage of grounding, reported as five. Now the
     * duplicate collapses and the other four slots hold real, different text.
     */
    const contents: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const document = await seedDocument(`Doc ${i}`);
      const own = `Unique paragraph number ${i}.`;
      contents.push(own);
      /* The shared paragraph nearest the query, the document's own text far
         from it, so ranking is decided rather than incidental. */
      await ingest(document, [SHARED, own], [axis(0), axis(i + 1)]);
    }

    expect(await countChunks()).toBe(6);

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
        limit: 5,
      }),
    );

    expect(found).toHaveLength(5);

    /* Five passages, five different texts. This is the line that fails on the
       old shape, where all five would read identically. */
    expect(new Set(found.map((chunk) => chunk.content)).size).toBe(5);

    /* And the shared one is a single result citing all five documents. */
    const shared = found.find((chunk) => chunk.content === SHARED)!;
    expect(shared.sources).toHaveLength(5);
  });
});

describe("re-ingesting a document", () => {
  it("drops passages it no longer contains", async () => {
    /*
     * The property the old delete-then-insert had, kept. A shortened document
     * must not leave its tail behind as passages that are still retrievable and
     * no longer true.
     */
    const document = await seedDocument("Terms");

    await ingest(document, ["First.", "Second.", "Third."]);
    expect(await countChunks()).toBe(3);

    await ingest(document, ["First."]);
    expect(await countChunks()).toBe(1);
  });

  it("does not disturb a passage another document also contains", async () => {
    const terms = await seedDocument("Terms");
    const faq = await seedDocument("FAQ");

    await ingest(terms, [SHARED]);
    await ingest(faq, [SHARED, "FAQ-only sentence."]);

    /* Terms is re-ingested without the shared paragraph. The chunk survives,
       because FAQ still contains it - only Terms stops being a source. */
    await ingest(terms, ["Terms-only sentence."]);

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
        limit: 5,
      }),
    );

    const shared = found.find((chunk) => chunk.content === SHARED)!;
    expect(shared.sources.map((source) => source.documentTitle)).toEqual(["FAQ"]);
  });
});

describe("deleting a document", () => {
  it("keeps a passage another document still contains", async () => {
    const terms = await seedDocument("Terms");
    const faq = await seedDocument("FAQ");

    await ingest(terms, [SHARED]);
    await ingest(faq, [SHARED]);

    const result = await withCompany(company.id, (db, companyId) =>
      deleteDocumentAndOrphanedChunks(db, companyId, {
        documentId: terms,
        knowledgeBaseId: baseId,
      }),
    );

    expect(result).toEqual({ documentDeleted: true, chunksDeleted: 0 });
    expect(await countChunks()).toBe(1);

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
      }),
    );

    /* Still retrievable, and now citing only the document that still has it -
       never the deleted one. */
    expect(found[0]!.sources.map((source) => source.documentTitle)).toEqual([
      "FAQ",
    ]);
  });

  it("removes a passage whose last source was that document", async () => {
    /*
     * The disclosure half. A chunk left with no sources is still in the index
     * and still scores, so the assistant would answer out of a document the
     * tenant deleted and cite a document that no longer exists. Nothing about a
     * foreign key expresses "delete the parent when its last child goes".
     */
    const terms = await seedDocument("Terms");
    const faq = await seedDocument("FAQ");

    await ingest(terms, [SHARED, "Only in Terms."]);
    await ingest(faq, [SHARED]);

    expect(await countChunks()).toBe(2);

    const result = await withCompany(company.id, (db, companyId) =>
      deleteDocumentAndOrphanedChunks(db, companyId, {
        documentId: terms,
        knowledgeBaseId: baseId,
      }),
    );

    expect(result).toEqual({ documentDeleted: true, chunksDeleted: 1 });

    const found = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(1),
        limit: 5,
      }),
    );

    expect(found.map((chunk) => chunk.content)).toEqual([SHARED]);
  });

  it("reports nothing deleted for a document that is not this company's", async () => {
    /* Rule 6 at the storage layer: not yours means it does not exist, and the
       caller must not be able to tell those apart by the return value. */
    const result = await withCompany(company.id, (db, companyId) =>
      deleteDocumentAndOrphanedChunks(db, companyId, {
        documentId: "no-such-document",
        knowledgeBaseId: baseId,
      }),
    );

    expect(result).toEqual({ documentDeleted: false, chunksDeleted: 0 });
  });
});
