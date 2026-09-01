import { beforeEach, describe, expect, it } from "vitest";

import { VERSE_EMBEDDING, groundingFor } from "@whatsapp-os/core/verse";
import {
  embeddingModelsInBase,
  replaceChunks,
  retrieveChunks,
  withCompany,
} from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Retrieval against real pgvector, which is the only thing that proves it.
 *
 * The pure half - the floor, the ordering, the refusal - is asserted in
 * packages/core with no database at all. What cannot be asserted there is that
 * the SQL is right: that `<=>` is a distance and not a similarity, that the
 * ORDER BY is ascending in the direction that puts the CLOSEST passage first,
 * and that the conversion between them has the sign the right way round.
 *
 * That family of fault produces no error. Every score stays in range, every
 * result sorts, and retrieval confidently returns the least relevant chunk in
 * the base. So it is asserted here, end to end, with vectors whose distances
 * are known by construction.
 */

let alpha: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("verse-retrieval");
});

const DIMS = VERSE_EMBEDDING.dimensions;

/**
 * A unit vector pointing along one axis.
 *
 * Orthogonal axes give a cosine similarity of exactly 0 and identical axes
 * exactly 1, so the expected ordering is arithmetic rather than a guess about
 * what an embedding model would produce.
 */
function axis(index: number): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  vector[index] = 1;
  return vector;
}

/** Halfway between two axes: cosine similarity ~0.707 with either. */
function between(a: number, b: number): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  const component = Math.SQRT1_2;
  vector[a] = component;
  vector[b] = component;
  return vector;
}

async function seedBase(company: SeededCompany) {
  return withCompany(company.id, async (db, companyId) => {
    const base = await db.knowledgeBase.create({
      data: {
        companyId,
        name: "Handbook",
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
      },
      select: { id: true },
    });

    const document = await db.kbDocument.create({
      data: {
        companyId,
        knowledgeBaseId: base.id,
        kind: "FILE",
        title: "Delivery and returns",
        filename: "handbook.pdf",
        mimeType: "application/pdf",
        status: "INDEXED",
      },
      select: { id: true },
    });

    return { baseId: base.id, documentId: document.id };
  });
}

describe("storing and retrieving passages", () => {
  it("returns the nearest passage first, with similarity not distance", async () => {
    /*
     * The assertion the whole file exists for.
     *
     * Chunk A is exactly the query. Chunk B is 45 degrees away. Chunk C is
     * orthogonal. So the expected order is A, B, C and the expected
     * similarities are 1, ~0.707, ~0 - which is only true if `<=>` is being
     * read as a DISTANCE and converted. Read as a similarity, the order
     * reverses and every number is wrong by construction.
     */
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [
          { seq: 0, content: "exactly the query", tokenCount: 3, embedding: axis(0) },
          { seq: 1, content: "half way", tokenCount: 2, embedding: between(0, 1) },
          { seq: 2, content: "unrelated", tokenCount: 1, embedding: axis(1) },
        ],
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
      }),
    );

    expect(found.map((chunk) => chunk.content)).toEqual([
      "exactly the query",
      "half way",
      "unrelated",
    ]);

    expect(found[0]!.similarity).toBeCloseTo(1, 5);
    expect(found[1]!.similarity).toBeCloseTo(Math.SQRT1_2, 5);
    expect(found[2]!.similarity).toBeCloseTo(0, 5);
  });

  it("carries the document title, so a passage can be attributed", async () => {
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [{ seq: 0, content: "x", tokenCount: 1, embedding: axis(0) }],
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, { knowledgeBaseId: baseId, embedding: axis(0) }),
    );

    expect(found[0]!.documentTitle).toBe("Delivery and returns");
  });

  it("feeds groundingFor, which refuses an orthogonal match", async () => {
    /*
     * The two halves together. The database returns the nearest passage
     * whatever it scores - so an index with nothing relevant in it still
     * returns a row - and the floor is what turns that into a refusal.
     *
     * Without this pairing the system answers every question from whatever
     * happened to be closest, which is the failure the whole phase is about.
     */
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [
          { seq: 0, content: "nothing to do with it", tokenCount: 4, embedding: axis(5) },
        ],
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, { knowledgeBaseId: baseId, embedding: axis(0) }),
    );

    /* A row came back... */
    expect(found).toHaveLength(1);
    /* ...and it is not evidence. */
    expect(groundingFor(found).kind).toBe("ungrounded");
  });

  it("replaces a document's passages rather than merging them", async () => {
    /*
     * A re-ingested document is not the same document with edits: it has a
     * different number of chunks at different boundaries. Merging by `seq`
     * would leave the tail of a shortened document behind as passages that are
     * still retrievable and no longer true.
     */
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [
          { seq: 0, content: "old one", tokenCount: 2, embedding: axis(0) },
          { seq: 1, content: "old two", tokenCount: 2, embedding: axis(1) },
          { seq: 2, content: "old three", tokenCount: 2, embedding: axis(2) },
        ],
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [{ seq: 0, content: "new only", tokenCount: 2, embedding: axis(0) }],
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
        limit: 50,
      }),
    );

    expect(found.map((chunk) => chunk.content)).toEqual(["new only"]);
  });

  it("does not retrieve across knowledge bases", async () => {
    /*
     * A campaign names its base. Answering from a base the tenant did not
     * choose is the same class of error as answering from another tenant's -
     * less severe and equally invisible.
     */
    const first = await seedBase(alpha);
    const second = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: first.baseId,
        documentId: first.documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [{ seq: 0, content: "in the first", tokenCount: 3, embedding: axis(0) }],
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: second.baseId,
        embedding: axis(0),
      }),
    );

    expect(found).toEqual([]);
  });

  it("respects the limit", async () => {
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: Array.from({ length: 10 }, (_, index) => ({
          seq: index,
          content: `chunk ${index}`,
          tokenCount: 2,
          embedding: axis(index),
        })),
      }),
    );

    const found = await withCompany(alpha.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: baseId,
        embedding: axis(0),
        limit: 3,
      }),
    );

    expect(found).toHaveLength(3);
  });
});

describe("the mixed-index check", () => {
  it("reports one model for a clean base", async () => {
    const { baseId, documentId } = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [{ seq: 0, content: "x", tokenCount: 1, embedding: axis(0) }],
      }),
    );

    const models = await withCompany(alpha.id, (db, companyId) =>
      embeddingModelsInBase(db, companyId, baseId),
    );

    expect(models).toEqual([VERSE_EMBEDDING.model]);
  });

  it("reports both when a base has been half re-embedded", async () => {
    /*
     * The state a re-embedding migration passes through, and the one thing
     * that can see it. A mixed index is otherwise completely invisible: every
     * score stays in range and every result sorts.
     */
    const { baseId, documentId } = await seedBase(alpha);
    const second = await seedBase(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId,
        embeddingModel: VERSE_EMBEDDING.model,
        embeddingVersion: VERSE_EMBEDDING.version,
        chunks: [{ seq: 0, content: "new", tokenCount: 1, embedding: axis(0) }],
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      replaceChunks(db, companyId, {
        knowledgeBaseId: baseId,
        documentId: second.documentId,
        embeddingModel: "some-older-model",
        embeddingVersion: 1,
        chunks: [{ seq: 0, content: "old", tokenCount: 1, embedding: axis(1) }],
      }),
    );

    const models = await withCompany(alpha.id, (db, companyId) =>
      embeddingModelsInBase(db, companyId, baseId),
    );

    expect(models).toEqual(["some-older-model", VERSE_EMBEDDING.model]);
  });
});
