-- ===========================================================================
-- ONE PASSAGE, MANY SOURCES
-- ===========================================================================
--
-- kb_chunks held one row per (document, position). Identical text appearing in
-- two documents was two rows with the same content and the same vector.
--
-- That is not a storage problem, it is a retrieval one. Retrieval is
-- `ORDER BY embedding <=> $q LIMIT k`, and duplicates score identically -- so
-- they arrive together at the top and the answer is grounded in ONE passage
-- while the code, the /dev/rag harness and the operator all count k. The
-- grounding is thinner than everything above it believes, and nothing says so.
-- With k = 5 and a boilerplate paragraph in five documents, a question can be
-- answered from a single sentence that five citations agree on.
--
-- Identical text is ordinary here: a footer repeated across documents, the same
-- page crawled under two URLs, a PDF and its web version both uploaded, a terms
-- section quoted in a FAQ.
--
-- So: kb_chunks is keyed by content within a knowledge base, and kb_chunk_sources
-- records every place that content appears. `document_id` and `seq` move there,
-- because one passage can be position 3 of one document and position 40 of
-- another.
--
-- ---------------------------------------------------------------------------
-- The order of what follows, and why it is this order
-- ---------------------------------------------------------------------------
--
--   1. kb_chunk_sources, created and backfilled BEFORE RLS is switched on.
--      A new table is owned by whatsapp_owner and has no policies yet, so the
--      backfill needs no FORCE dance. Enabling RLS afterwards is one statement;
--      doing it first would mean the NO FORCE / UPDATE / FORCE sequence twice.
--   2. content_hash on kb_chunks, backfilled -- and that one DOES need the
--      dance, because kb_chunks already has FORCE ROW LEVEL SECURITY and a
--      bare UPDATE as the owner matches no policy, touches zero rows and
--      reports success.
--   3. Merge the duplicates that already exist, repointing their sources.
--   4. Only then the unique index, which would fail against unmerged rows.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The sources table
-- ---------------------------------------------------------------------------

CREATE TABLE "kb_chunk_sources" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,

    -- Position in THIS document. The same passage can sit at a different
    -- position in each document that contains it, which is exactly why this
    -- column could not stay on kb_chunks.
    "seq" INTEGER NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "kb_chunk_sources_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "kb_chunk_sources" ADD CONSTRAINT "kb_chunk_sources_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kb_chunk_sources" ADD CONSTRAINT "kb_chunk_sources_chunk_id_fkey"
  FOREIGN KEY ("chunk_id") REFERENCES "kb_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kb_chunk_sources" ADD CONSTRAINT "kb_chunk_sources_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One passage per position in a document: the key kb_chunks used to carry,
-- moved to the table where it is now true.
CREATE UNIQUE INDEX "kb_chunk_sources_company_id_document_id_seq_key"
  ON "kb_chunk_sources"("company_id", "document_id", "seq");

-- Leads with company_id, per rule 2. Serves "every source of this chunk",
-- which is what retrieval joins on to build a citation.
CREATE INDEX "kb_chunk_sources_company_id_chunk_id_idx"
  ON "kb_chunk_sources"("company_id", "chunk_id");

-- Backfill: every existing chunk is a passage with exactly one source, which is
-- what the old shape meant. No RLS to work around yet - the table is new and
-- has no policies until the block at the bottom.
INSERT INTO "kb_chunk_sources" (id, company_id, chunk_id, document_id, seq, created_at)
SELECT gen_random_uuid()::text, c.company_id, c.id, c.document_id, c.seq, c.created_at
  FROM "kb_chunks" c;

-- ---------------------------------------------------------------------------
-- 2. content_hash
-- ---------------------------------------------------------------------------

ALTER TABLE "kb_chunks" ADD COLUMN "content_hash" TEXT;

-- The FORCE dance. kb_chunks carries FORCE ROW LEVEL SECURITY and its policies
-- are scoped TO app_runtime, so this UPDATE as whatsapp_owner would match no
-- policy, touch zero rows, report success and leave every hash NULL - and the
-- NOT NULL below would then fail with nothing to explain it.
--
-- Drop FORCE, never the policy: app_runtime stays constrained throughout.
-- packages/db/tests/force-rls-backfill.test.ts is the worked example.
ALTER TABLE "kb_chunks" NO FORCE ROW LEVEL SECURITY;

-- sha256() over the UTF-8 bytes, hex. Identical to
-- createHash("sha256").update(content, "utf8").digest("hex") in Node, which is
-- what replaceChunks writes from now on - a mismatch between the two would
-- deduplicate nothing and be invisible, because both sides would still be
-- internally consistent.
UPDATE "kb_chunks"
   SET "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex');

ALTER TABLE "kb_chunks" FORCE ROW LEVEL SECURITY;

ALTER TABLE "kb_chunks" ALTER COLUMN "content_hash" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Merge the duplicates that already exist
-- ---------------------------------------------------------------------------
--
-- Survivor is the lowest id within each (company, base, hash) group - an
-- arbitrary but TOTAL choice, for the reason the ordering rule gives: `MIN(id)`
-- on the primary key cannot tie, so this migration produces the same result
-- whatever the plan does.
--
-- Sources are repointed before the losers are deleted, or the cascade would
-- take them with it and a document would silently lose its passages.

CREATE TEMP TABLE chunk_merge AS
SELECT c.id AS loser_id,
       (SELECT MIN(c2.id)
          FROM "kb_chunks" c2
         WHERE c2.company_id = c.company_id
           AND c2.knowledge_base_id = c.knowledge_base_id
           AND c2.content_hash = c.content_hash) AS survivor_id
  FROM "kb_chunks" c;

DELETE FROM chunk_merge WHERE loser_id = survivor_id;

ALTER TABLE "kb_chunk_sources" NO FORCE ROW LEVEL SECURITY;

UPDATE "kb_chunk_sources" s
   SET "chunk_id" = m.survivor_id
  FROM chunk_merge m
 WHERE s."chunk_id" = m.loser_id;

ALTER TABLE "kb_chunk_sources" FORCE ROW LEVEL SECURITY;

ALTER TABLE "kb_chunks" NO FORCE ROW LEVEL SECURITY;

DELETE FROM "kb_chunks" WHERE id IN (SELECT loser_id FROM chunk_merge);

ALTER TABLE "kb_chunks" FORCE ROW LEVEL SECURITY;

DROP TABLE chunk_merge;

-- ---------------------------------------------------------------------------
-- 4. kb_chunks loses what moved, and gains its key
-- ---------------------------------------------------------------------------

DROP INDEX "kb_chunks_company_id_document_id_seq_key";

ALTER TABLE "kb_chunks" DROP CONSTRAINT "kb_chunks_document_id_fkey";
ALTER TABLE "kb_chunks" DROP COLUMN "document_id";
ALTER TABLE "kb_chunks" DROP COLUMN "seq";

-- Per knowledge base rather than per company, deliberately. Two bases are two
-- indexes and one may be re-embedded while the other is not; a row shared
-- across them would belong to two embedding pins at once.
CREATE UNIQUE INDEX "kb_chunks_company_id_knowledge_base_id_content_hash_key"
  ON "kb_chunks"("company_id", "knowledge_base_id", "content_hash");

-- ---------------------------------------------------------------------------
-- 5. RLS on the new table
-- ---------------------------------------------------------------------------
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin for tables created by whatsapp_owner, and never
-- TRUNCATE.

ALTER TABLE "kb_chunk_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_chunk_sources" FORCE ROW LEVEL SECURITY;

CREATE POLICY kb_chunk_sources_company_isolation ON "kb_chunk_sources"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY kb_chunk_sources_admin_access ON "kb_chunk_sources"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
