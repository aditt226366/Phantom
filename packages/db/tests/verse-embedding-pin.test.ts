import { describe, expect, it } from "vitest";

import { VERSE_EMBEDDING } from "@whatsapp-os/core/verse";
import { superuserClient } from "./helpers.ts";

/**
 * The embedding pin, where the constant and the column meet.
 *
 * ---------------------------------------------------------------------------
 * What this test is actually preventing
 * ---------------------------------------------------------------------------
 *
 * Two vectors are comparable only if the same model produced them. A similarity
 * score between an embedding from model A and one from model B is not a worse
 * number - it is a meaningless one, and meaningless in the most dangerous
 * available shape: it is still a float, it still sorts, it still clears the
 * retrieval floor, and it still hands the generator a passage with nothing to
 * do with the question.
 *
 * Nothing throws. No test fails. Retrieval quality collapses, and the first
 * symptom in production is a fluent, confident answer citing the wrong
 * paragraph of the tenant's own refund policy.
 *
 * So the model is pinned in three places that must agree:
 *
 *   1. VERSE_EMBEDDING.model / .dimensions   packages/core/src/verse/models.ts
 *   2. kb_chunks.embedding                   vector(N), fixed in DDL
 *   3. knowledge_bases.embedding_model       stamped per index, per row
 *
 * This file asserts (1) and (2) agree by reading the column's width out of the
 * catalog. That is what makes changing the constant alone FAIL - and the only
 * way to make it pass again is to write a migration, which is exactly the
 * deliberate, versioned re-embedding the pin exists to force. There is no path
 * where somebody edits a model name in a config file and the system quietly
 * keeps serving.
 *
 * It reads the catalog rather than the migration text, because a migration that
 * was amended after being applied says one thing on disk and another in the
 * database - which is the whole C10 incident, and the reason db:verify exists.
 */

describe("the embedding model is pinned to the column", () => {
  it("gives kb_chunks.embedding exactly the constant's dimensions", async () => {
    const client = superuserClient();

    try {
      /*
       * atttypmod carries a vector's declared width. For pgvector it is the
       * dimension count directly - unlike varchar, where it is length + 4.
       */
      const { rows } = await client.query(
        `SELECT a.atttypmod AS dimensions, t.typname AS type
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type t ON t.oid = a.atttypid
          WHERE n.nspname = 'public'
            AND c.relname = 'kb_chunks'
            AND a.attname = 'embedding'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("vector");
      expect(rows[0].dimensions).toBe(VERSE_EMBEDDING.dimensions);
    } finally {
      await client.end();
    }
  });

  it("keeps the vector index, which migrate diff wants to drop on every run", async () => {
    /*
     * schema.prisma cannot express an HNSW index and cannot index an
     * `Unsupported` column at all, so `prisma migrate diff` reports this index
     * as drift for ever and migrate-test.mjs waives exactly that one statement.
     *
     * A waiver that says "ignore the DROP" would also go quiet if the index
     * were genuinely dropped. This is the other half: db:verify carries the
     * same assertion through OUT_OF_BAND_DDL, and this is the one that runs in
     * the suite.
     */
    const client = superuserClient();

    try {
      const { rows } = await client.query(
        `SELECT i.relname AS name, am.amname AS method
           FROM pg_class i
           JOIN pg_index x ON x.indexrelid = i.oid
           JOIN pg_class c ON c.oid = x.indrelid
           JOIN pg_am am ON am.oid = i.relam
          WHERE c.relname = 'kb_chunks' AND am.amname = 'hnsw'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("kb_chunks_embedding_hnsw_idx");
    } finally {
      await client.end();
    }
  });

  it("records the model on the base and on every chunk", async () => {
    /*
     * The per-chunk column is redundant with the per-base one on every correct
     * row, and that is the point: during a re-embedding migration it is the
     * only way to tell a converted row from an unconverted one. A mixed index
     * is otherwise completely invisible.
     */
    const client = superuserClient();

    try {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name, a.attname AS column_name, a.attnotnull
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname IN ('knowledge_bases', 'kb_chunks')
            AND a.attname IN ('embedding_model', 'embedding_version')
          ORDER BY c.relname, a.attname`,
      );

      expect(rows.map((r: { table_name: string; column_name: string }) =>
        `${r.table_name}.${r.column_name}`,
      )).toEqual([
        "kb_chunks.embedding_model",
        "kb_chunks.embedding_version",
        "knowledge_bases.embedding_model",
        "knowledge_bases.embedding_version",
      ]);

      /* NOT NULL on all four: a chunk that does not say what embedded it is a
         chunk nothing can audit after a model change. */
      for (const row of rows) {
        expect(row.attnotnull).toBe(true);
      }
    } finally {
      await client.end();
    }
  });
});
