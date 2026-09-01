-- Phase 9: the Verse AI layer. Knowledge, campaigns, and one driver per thread.
--
-- ===========================================================================
-- WHAT THIS PHASE IS, IN ONE PARAGRAPH
-- ===========================================================================
--
-- A tenant uploads what their business knows. A customer asks a question. We
-- retrieve the passages that actually answer it, hand ONLY those to a model,
-- and send back what it writes. If nothing retrieved is good enough, Verse says
-- it does not know and asks for a person.
--
-- That last sentence is the product. A retrieval system that falls back on the
-- model's general knowledge when its index comes up empty is not a worse
-- version of this - it is a different and much more dangerous thing, because
-- the failure is invisible: a confident, fluent, well-formatted answer about
-- this business's refund policy, invented. Everything below is shaped by making
-- that failure impossible rather than unlikely.
--
-- ===========================================================================
-- THE EMBEDDING PIN, WHICH IS THE ONE THING THAT CANNOT BE A CONFIG EDIT
-- ===========================================================================
--
-- Two vectors are comparable only if the same model produced them. Cosine
-- similarity between an embedding from model A and one from model B is not a
-- worse number, it is a meaningless one - and meaningless in the worst
-- available way, because it still returns a float, still sorts, still clears a
-- floor, and still hands the generator a passage with nothing to do with the
-- question. Nothing throws. Retrieval quality collapses and the first symptom
-- is a confident answer citing the wrong paragraph.
--
-- So the model is pinned, and the pin is spread across three places that must
-- agree:
--
--   packages/core/src/verse/models.ts  VERSE_EMBEDDING.model / .dimensions
--   kb_chunks.embedding                vector(1536), fixed HERE in DDL
--   knowledge_bases.embedding_model    stamped per index, per row
--
-- packages/db/tests/verse-embedding-pin.test.ts reads the column's dimension
-- out of the catalog and asserts it equals the constant. So editing the
-- constant alone FAILS THE SUITE, and the only way to make it pass is to write
-- a migration - which is exactly the deliberate, versioned re-embedding this
-- comment exists to force. There is no path where somebody changes a model
-- name in a config file and the system quietly keeps serving.
--
-- If you are here to change the embedding model: you need a new migration that
-- adds a column, re-embeds every row into it, and swaps. Not an ALTER on this
-- one, because every stored vector is wrong the instant the model changes and
-- a column that briefly holds both is a column nothing can query correctly.

-- ===========================================================================
-- THE EXTENSION IS NOT CREATED HERE, AND CANNOT BE
-- ===========================================================================
--
-- Migrations run as whatsapp_owner, which is NOSUPERUSER by rule 1, and the
-- `vector` extension is not marked trusted in the pgvector image:
--
--     ERROR:  permission denied to create extension "vector"
--     HINT:   Must be superuser to create this extension.
--
-- So `CREATE EXTENSION` here would be a migration the migrating role cannot
-- apply. Worse, it would fail on a FRESH database only - anybody whose
-- extension already existed would see it pass, and every new clone would see
-- it fail.
--
-- It is provisioned by scripts/db-roles.mjs, which is the one place holding
-- superuser and which already runs after the database exists and before
-- `migrate deploy` - the ordering db-nuke.mjs sets out at length.
--
-- What this migration does instead is REFUSE to run without it, naming the
-- remedy. Without this block the first symptom is `type "vector" does not
-- exist` on a CREATE TABLE below, which is accurate and tells nobody what to
-- do about it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector is not installed in this database. It is provisioned by the superuser, not by migrations - run `npm run db:roles` and then retry `migrate deploy`. If db:roles also fails, the Postgres image is wrong: docker-compose.yml pins pgvector/pgvector:pg17 and plain postgres:17 does not carry the extension.';
  END IF;
END
$$;

-- ===========================================================================
-- ENUMS
-- ===========================================================================

-- Who is currently speaking for the business in a thread.
--
-- ---------------------------------------------------------------------------
-- Why this is a column and not three booleans, and not derived
-- ---------------------------------------------------------------------------
--
-- Phase 8 shipped the two-writer bug and its fix: a flow run standing in a
-- thread while an operator types in the same thread is a conversation with two
-- authors, neither aware of the other, and only the customer able to see both.
-- That was solved for two writers by having the inbox hand off any live run.
--
-- There are three now. An operator, a flow run, and Verse. Three writers is
-- where "whoever wrote last wins" stops being survivable, because the losing
-- writer is not merely overwritten - it CARRIES ON, on its own schedule, into
-- a conversation somebody else is having.
--
-- A single column is the whole mechanism. "At most one driver" is not a rule
-- anybody has to enforce; it is a thing this type cannot express the negation
-- of. Three booleans would need a CHECK to say the same and a correct writer
-- at every site to keep it; one enum needs neither.
--
-- NOBODY is a real member rather than NULL. A nullable driver puts three-valued
-- logic into every read of the most-read column in the inbox, and `driver IS
-- DISTINCT FROM 'VERSE'` is the kind of predicate people write as `!=` and get
-- wrong for exactly the rows that matter.
CREATE TYPE "conversation_driver" AS ENUM ('NOBODY', 'OPERATOR', 'FLOW', 'VERSE');

-- What a knowledge base document is, and where its bytes came from.
CREATE TYPE "kb_source_kind" AS ENUM ('FILE', 'URL');

-- Where a document is in the pipeline. Per document, never per base, because
-- one unreadable PDF must not make an entire knowledge base look broken.
CREATE TYPE "kb_document_status" AS ENUM (
  'PENDING',     -- accepted, nothing done yet
  'EXTRACTING',  -- pulling text out of the bytes
  'EMBEDDING',   -- chunked, vectors being written
  'INDEXED',     -- retrievable
  'FAILED'       -- see failure_reason, which is NOT NULL when this is set
);

CREATE TYPE "verse_campaign_status" AS ENUM (
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  -- Stopped by us, not by a person: the template was rejected or paused by
  -- Meta mid-flight. Distinct from PAUSED because a person did not do it and
  -- resuming will not fix it - see stopped_reason.
  'STOPPED',
  'ARCHIVED'
);

CREATE TYPE "verse_recipient_status" AS ENUM (
  'PENDING',
  'SENT',
  'SKIPPED',
  'FAILED'
);

-- 'VERSE' is added to lead_source_action by the migration IMMEDIATELY BEFORE
-- this one, and it is a separate file for a reason worth keeping.
--
-- PostgreSQL refuses to USE a new enum value in the transaction that added it:
--
--     ERROR:  unsafe use of new value "VERSE" of enum type lead_source_action
--     HINT:   New enum values must be committed before they can be used.
--
-- The CHECK constraint below names 'VERSE', so the ALTER TYPE and the CHECK
-- cannot share a migration. Splitting them is the documented fix and the only
-- one that does not depend on how the migration runner wraps a file.

-- ===========================================================================
-- THE DRIVER, ON CONVERSATIONS
-- ===========================================================================

ALTER TABLE "conversations"
  ADD COLUMN "driver" "conversation_driver" NOT NULL DEFAULT 'NOBODY',
  -- Since when, for the same reason needs_human_at is an instant rather than a
  -- boolean: "an operator has had this for forty minutes" is a fact somebody
  -- acts on, and a boolean cannot say it.
  ADD COLUMN "driver_since" TIMESTAMPTZ(3),
  -- Which run or campaign, so the inbox can say "Verse (Diwali offers)" rather
  -- than "Verse". Deliberately a bare text id and NOT a foreign key: it points
  -- into two different tables depending on the driver, and a thread must not
  -- become unreadable because a campaign was archived.
  ADD COLUMN "driver_ref" TEXT;

-- The two halves agree or the row does not exist.
--
-- Modelled on needs_human_at/needs_human_reason, which had the same problem: a
-- driver_since left behind by a release would make a released thread render as
-- though something had been holding it since Tuesday.
ALTER TABLE "conversations"
  ADD CONSTRAINT conversations_driver_has_its_instant
  CHECK (("driver" = 'NOBODY') = ("driver_since" IS NULL));

-- A driver_ref without a driver is a dangling pointer that renders.
ALTER TABLE "conversations"
  ADD CONSTRAINT conversations_driver_ref_needs_a_driver
  CHECK ("driver_ref" IS NULL OR "driver" <> 'NOBODY');

-- "Which threads is Verse holding", which the dashboard card and the campaign
-- detail page both read.
CREATE INDEX "conversations_company_id_driver_idx"
  ON "conversations"("company_id", "driver");

-- ===========================================================================
-- KNOWLEDGE
-- ===========================================================================

CREATE TABLE "knowledge_bases" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    -- The pin, stamped per index.
    --
    -- Denormalised from the constant deliberately. The constant says what NEW
    -- work uses; this says what the vectors in this base actually came from,
    -- and after a re-embedding migration those two disagree for as long as the
    -- migration is running. A retrieval that cannot tell the difference is one
    -- that mixes models for the duration.
    "embedding_model" TEXT NOT NULL,
    "embedding_version" INTEGER NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    -- Archived rather than deleted: a campaign that ran against this base is a
    -- record of what customers were told, and the passages are the only
    -- evidence of why the answers said what they said.
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kb_documents" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,

    "kind" "kb_source_kind" NOT NULL,
    "title" TEXT NOT NULL,
    -- Set for URL, null for FILE.
    "source_url" TEXT,
    -- Set for FILE, null for URL.
    "filename" TEXT,
    "mime_type" TEXT,
    "byte_size" INTEGER,

    "status" "kb_document_status" NOT NULL DEFAULT 'PENDING',

    -- Why it failed, in words an operator can act on.
    --
    -- NOT a boolean and not an error code. The realistic failures here are
    -- "this PDF is a scan with no text layer", "the server returned 403" and
    -- "robots.txt disallows this path", and each has a different remedy that
    -- the tenant can carry out themselves. A red dot saying FAILED sends them
    -- to support for something they could have fixed in a minute.
    "failure_reason" TEXT,

    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMPTZ(3),

    -- sha256 of the extracted TEXT, not of the bytes.
    --
    -- The bytes of a PDF change when its producer re-saves it and the words do
    -- not; re-embedding two thousand chunks because Acrobat rewrote a
    -- timestamp is a real bill. Text is what the index is actually made of.
    "content_hash" TEXT,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id")
);

-- A failure must say why, and a success must not claim one.
--
-- The first half is the one that matters: a FAILED row with a null reason is a
-- dead end for whoever is looking at it, and this is the only place that can
-- make writing one impossible.
ALTER TABLE "kb_documents"
  ADD CONSTRAINT kb_documents_failure_has_a_reason
  CHECK (("status" = 'FAILED') = ("failure_reason" IS NOT NULL));

-- Each kind carries its own locator, and only its own.
ALTER TABLE "kb_documents"
  ADD CONSTRAINT kb_documents_kind_has_its_locator
  CHECK (
    ("kind" = 'FILE' AND "filename" IS NOT NULL AND "source_url" IS NULL)
    OR ("kind" = 'URL' AND "source_url" IS NOT NULL AND "filename" IS NULL)
  );

CREATE TABLE "kb_chunks" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,

    -- Position in the document, so a retrieved passage can be shown in context
    -- and two adjacent hits can be recognised as adjacent.
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,

    -- The pin, in DDL. See the header. 1536 = text-embedding-3-small.
    "embedding" vector(1536) NOT NULL,

    -- Which model produced THIS vector.
    --
    -- Redundant with the knowledge base's column on every correct row, and
    -- that is the point: during a re-embedding migration it is the only way to
    -- tell a converted row from an unconverted one, and a mixed index is
    -- otherwise invisible. verse-embedding-pin.test.ts asserts no base holds
    -- two.
    "embedding_model" TEXT NOT NULL,
    "embedding_version" INTEGER NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- CAMPAIGNS
-- ===========================================================================

CREATE TABLE "verse_campaigns" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    -- The tenant's own words, verbatim into the system prompt.
    --
    -- Stored as written and never normalised, summarised or reformatted. The
    -- goal is the one part of the prompt the tenant authored, and editing it on
    -- their behalf - even to fix spelling - changes what the model was asked to
    -- do in a way nobody can see from the UI.
    "goal" TEXT NOT NULL,

    -- What opens the conversation. An approved template, because nothing else
    -- may be sent before a window exists.
    "template_id" TEXT NOT NULL,
    -- 'V1' | 'V2' | 'V3'. Text, not an enum, because the tiers are defined in
    -- packages/core/src/verse/models.ts and a Prisma enum here could only ever
    -- disagree with it - the same argument usage_events.kind already makes.
    "model_tier" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,

    "status" "verse_campaign_status" NOT NULL DEFAULT 'DRAFT',
    -- Why we stopped it. NOT NULL exactly when status is STOPPED.
    "stopped_reason" TEXT,

    -- ---------------------------------------------------------------------
    -- The schedule, in the tenant's own timezone
    -- ---------------------------------------------------------------------
    --
    -- An IANA name, not an offset. An offset is wrong twice a year, and the
    -- failure it produces is messaging people an hour either side of a window
    -- that exists precisely so nobody is messaged at 2am.
    "timezone" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(3),

    -- Minutes past local midnight. NULL means no daily window - send whenever
    -- the run reaches them.
    --
    -- Minutes rather than a `time` column because the comparison is done in
    -- JavaScript against a tenant-local wall clock derived from the timezone
    -- above, and a `time` would invite comparing it in SQL against a server
    -- clock that is in UTC.
    "daily_window_start_minute" INTEGER,
    "daily_window_end_minute" INTEGER,
    -- Most messages per calendar day, in the tenant's timezone. NULL = no cap.
    "daily_cap" INTEGER,

    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verse_campaigns_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT verse_campaigns_stop_has_a_reason
  CHECK (("status" = 'STOPPED') = ("stopped_reason" IS NOT NULL));

-- Both ends of the window, or neither. A start with no end is a window that
-- never closes, which is the thing the window exists to prevent.
ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT verse_campaigns_window_is_whole
  CHECK (
    ("daily_window_start_minute" IS NULL) = ("daily_window_end_minute" IS NULL)
  );

-- A day is 1440 minutes. start < end, so the window cannot wrap midnight -
-- deliberately: a wrapping window is a 2am window, and refusing to represent
-- one is cheaper than validating every read of it.
ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT verse_campaigns_window_is_within_one_day
  CHECK (
    "daily_window_start_minute" IS NULL
    OR (
      "daily_window_start_minute" >= 0
      AND "daily_window_end_minute" <= 1440
      AND "daily_window_start_minute" < "daily_window_end_minute"
    )
  );

ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT verse_campaigns_daily_cap_is_positive
  CHECK ("daily_cap" IS NULL OR "daily_cap" > 0);

CREATE TABLE "verse_campaign_recipients" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,

    "contact_id" TEXT,
    "phone_e164" TEXT NOT NULL,
    -- The template's parameters, in Meta's positional order.
    "variables" JSONB NOT NULL DEFAULT '[]'::jsonb,

    "status" "verse_recipient_status" NOT NULL DEFAULT 'PENDING',
    -- Why this one was not sent. Same argument as kb_documents.failure_reason.
    "skip_reason" TEXT,
    -- Where the audience became an ordinary message, the way bulk does it.
    "message_id" TEXT,
    "conversation_id" TEXT,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verse_campaign_recipients_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT verse_campaign_recipients_skip_has_a_reason
  CHECK (("status" = 'SKIPPED') = ("skip_reason" IS NOT NULL));

-- A binding may point at a campaign, and must when its action says so.
ALTER TABLE "lead_sources" ADD COLUMN "verse_campaign_id" TEXT;

ALTER TABLE "lead_sources" DROP CONSTRAINT lead_sources_action_has_its_target;

ALTER TABLE "lead_sources"
  ADD CONSTRAINT lead_sources_action_has_its_target
  CHECK (
    (action = 'TEMPLATE' AND template_id IS NOT NULL)
    OR (action = 'FLOW' AND flow_version_id IS NOT NULL)
    OR (action = 'VERSE' AND verse_campaign_id IS NOT NULL)
  );

-- ===========================================================================
-- FOREIGN KEYS
-- ===========================================================================

ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_knowledge_base_id_fkey"
  FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_knowledge_base_id_fkey"
  FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade: re-uploading a document replaces its chunks, and a chunk whose
-- document is gone is a passage nothing can attribute.
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "verse_campaigns" ADD CONSTRAINT "verse_campaigns_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verse_campaigns" ADD CONSTRAINT "verse_campaigns_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT, not CASCADE. Deleting a knowledge base out from under a running
-- campaign would leave it retrieving from nothing and answering from the
-- model's general knowledge - the exact failure this phase exists to prevent.
ALTER TABLE "verse_campaigns" ADD CONSTRAINT "verse_campaigns_knowledge_base_id_fkey"
  FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT "verse_campaign_recipients_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT "verse_campaign_recipients_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "verse_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT "verse_campaign_recipients_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT "verse_campaign_recipients_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "verse_campaign_recipients"
  ADD CONSTRAINT "verse_campaign_recipients_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_verse_campaign_id_fkey"
  FOREIGN KEY ("verse_campaign_id") REFERENCES "verse_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- INDEXES
-- ===========================================================================
--
-- Every one leads with company_id, for the reason CLAUDE.md rule 2 gives and
-- one more that is specific to this schema: RLS rewrites every query to AND
-- `company_id = app_current_company()` before the planner sees it, so there is
-- no such thing as a query on these tables without that predicate.

CREATE INDEX "knowledge_bases_company_id_created_at_idx"
  ON "knowledge_bases"("company_id", "created_at" DESC);

CREATE INDEX "kb_documents_company_id_knowledge_base_id_created_at_idx"
  ON "kb_documents"("company_id", "knowledge_base_id", "created_at" DESC);

-- The ingestion worker's claim: "what in this base still needs doing".
CREATE INDEX "kb_documents_company_id_status_idx"
  ON "kb_documents"("company_id", "status");

CREATE INDEX "kb_chunks_company_id_knowledge_base_id_idx"
  ON "kb_chunks"("company_id", "knowledge_base_id");

-- Reading a document's passages back in order, for the /dev/rag harness and
-- for showing a retrieved chunk in context.
CREATE UNIQUE INDEX "kb_chunks_company_id_document_id_seq_key"
  ON "kb_chunks"("company_id", "document_id", "seq");

-- ---------------------------------------------------------------------------
-- The vector index, and an honest note about what it does not do
-- ---------------------------------------------------------------------------
--
-- HNSW with cosine ops, because the embeddings are normalised and cosine is
-- what the retrieval floor is expressed in. IVFFlat would need a training step
-- against a populated table, which is wrong for a table that starts empty on
-- every new tenant.
--
-- What this index cannot do is combine with the company predicate. RLS ANDs
-- `company_id = app_current_company()` into the scan, and an HNSW index has no
-- notion of it - so Postgres searches the graph and filters afterwards, which
-- means a tenant's recall degrades as OTHER tenants' rows are added. At the
-- scale this ships for - a knowledge base is tens to low thousands of chunks
-- and there is one index per installation - the filter is cheap and the recall
-- loss is not measurable.
--
-- It stops being true somewhere in the millions of chunks across all tenants.
-- The fix at that point is partitioning by company_id, or a partial index per
-- large tenant, and NOT raising ef_search until it looks fine. Recorded here
-- because the symptom - a tenant whose good answers slowly become "I don't
-- know" as the platform grows - is one that would be diagnosed as a prompt
-- problem for a long time before anybody suspected the index.
CREATE INDEX "kb_chunks_embedding_hnsw_idx"
  ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "verse_campaigns_company_id_created_at_idx"
  ON "verse_campaigns"("company_id", "created_at" DESC);
CREATE INDEX "verse_campaigns_company_id_status_idx"
  ON "verse_campaigns"("company_id", "status");

CREATE INDEX "verse_campaign_recipients_company_id_campaign_id_status_idx"
  ON "verse_campaign_recipients"("company_id", "campaign_id", "status");

-- One row per person per campaign.
--
-- The same argument as the lead-source idempotency index: a check-then-insert
-- loses to a retrying job, and what comes out of that race is a real customer
-- messaged twice by the same campaign.
CREATE UNIQUE INDEX "verse_campaign_recipients_company_id_campaign_id_phone_e164_key"
  ON "verse_campaign_recipients"("company_id", "campaign_id", "phone_e164");

CREATE INDEX "lead_sources_company_id_verse_campaign_id_idx"
  ON "lead_sources"("company_id", "verse_campaign_id");

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements for the ordinary CRUD: default privileges from
-- 20260814220000 already cover app_runtime and app_admin, and never TRUNCATE.

ALTER TABLE "knowledge_bases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_bases" FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_bases_company_isolation ON "knowledge_bases"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY knowledge_bases_admin_access ON "knowledge_bases"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "kb_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY kb_documents_company_isolation ON "kb_documents"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY kb_documents_admin_access ON "kb_documents"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "kb_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_chunks" FORCE ROW LEVEL SECURITY;

CREATE POLICY kb_chunks_company_isolation ON "kb_chunks"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY kb_chunks_admin_access ON "kb_chunks"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "verse_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verse_campaigns" FORCE ROW LEVEL SECURITY;

CREATE POLICY verse_campaigns_company_isolation ON "verse_campaigns"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY verse_campaigns_admin_access ON "verse_campaigns"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "verse_campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verse_campaign_recipients" FORCE ROW LEVEL SECURITY;

CREATE POLICY verse_campaign_recipients_company_isolation ON "verse_campaign_recipients"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY verse_campaign_recipients_admin_access ON "verse_campaign_recipients"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
