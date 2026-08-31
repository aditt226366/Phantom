-- Business verification documents: GST certificate, PAN card, Aadhaar.
--
-- ---------------------------------------------------------------------------
-- Append-only, one row per upload attempt
-- ---------------------------------------------------------------------------
--
-- The same shape as whatsapp_template_edits, for a sharper reason. These are
-- the documents a platform operator looked at when deciding to let a company
-- trade, and "what was actually approved" has to survive the tenant replacing
-- the file afterwards. A re-upload therefore INSERTs; nothing here is ever
-- overwritten, and the current state of a kind is the newest row for it.
--
-- The index is that read and only that read: (company_id, kind, created_at
-- DESC) makes "the newest GST row for this company" a seek rather than a sort.
--
-- ---------------------------------------------------------------------------
-- Deliberately not whatsapp_media, despite reusing everything about it
-- ---------------------------------------------------------------------------
--
-- whatsapp_media is unique on (company_id, sha256) and upserts onto it. That is
-- correct for one photo forwarded to fifty contacts and wrong twice over here:
-- two companies filing the same PDF must never share a row, and one company
-- re-filing identical bytes after a rejection is a new attempt that needs its
-- own verdict. So the storage pattern is reused - bytea, STORAGE EXTERNAL, a
-- CHECK on length, chunked reads through substring() - and the table is not.
--
-- There is no sha256 unique of any kind. The column is the download's ETag and
-- a way to notice a tenant re-filing the file that was already refused; making
-- it unique would refuse the second upload of a document an operator asked to
-- have sent again.
--
-- ---------------------------------------------------------------------------
-- The cap and the file type are both enforced three times
-- ---------------------------------------------------------------------------
--
--   1. During the upload stream. The read is abandoned the moment the running
--      byte count crosses 5 MiB, so a 200 MB body is never resident. Not from
--      Content-Length, which is the client's word, and not afterwards.
--   2. Before the INSERT, against the bytes in hand: the first five must be
--      %PDF-. Never the extension, never the browser's Content-Type - both are
--      supplied by whoever is uploading.
--   3. Here, as CHECK constraints. The backstops that do not depend on the
--      caller having behaved, which is the whole reason to have them: a second
--      upload path added later inherits these without knowing they exist.
--
-- kyc_documents_byte_size_matches ties the metadata to the content, so a row
-- cannot describe a length it does not hold - which is what makes it safe for
-- the download route to send byte_size as Content-Length.
--
-- CHECK constraints are invisible to Prisma and to `migrate diff`. They are
-- swept by OUT_OF_BAND_DDL in packages/db/scripts/invariants.mjs, which is what
-- notices if one is dropped.
--
-- ---------------------------------------------------------------------------
-- STORAGE EXTERNAL, for the reason 20260815140000 gives
-- ---------------------------------------------------------------------------
--
-- The read path slices this column with substring() to stream it without
-- materialising 5 MB in the request. Under the default EXTENDED the value is
-- compressed and a slice decompresses from the start, so the streaming becomes
-- a fiction that looks like it works. PDFs are already compressed internally,
-- so the setting costs nothing.

CREATE TYPE "kyc_document_kind" AS ENUM ('GST', 'PAN', 'AADHAAR');
CREATE TYPE "kyc_document_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" "kyc_document_kind" NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "status" "kyc_document_status" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_admin_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kyc_documents_company_id_kind_created_at_idx"
  ON "kyc_documents"("company_id", "kind", "created_at" DESC);

ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "kyc_documents_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: an operator leaving must not delete the record of the approval that
-- let a tenant start trading. The verdict outlives the person who gave it.
--
-- A tenant table referencing a global admin table is safe as written. Postgres
-- runs referential integrity checks with the constraint's own privileges and
-- they bypass row security, so this needs no grant on admin_users - which
-- app_runtime deliberately does not have and must never be given. The column
-- itself is an opaque cuid and no tenant-facing query selects it.
ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "kyc_documents_reviewed_by_admin_id_fkey"
  FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- STORAGE AND CONSTRAINTS
-- ===========================================================================

ALTER TABLE "kyc_documents" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

ALTER TABLE "kyc_documents"
  ADD CONSTRAINT kyc_documents_bytes_within_cap
  CHECK (octet_length(bytes) <= 5242880);

ALTER TABLE "kyc_documents"
  ADD CONSTRAINT kyc_documents_byte_size_matches
  CHECK (octet_length(bytes) = byte_size);

-- The magic-byte rule, in the database.
--
-- '%PDF-' as bytea rather than a text comparison: the column is binary and a
-- cast would depend on the server encoding accepting whatever the first five
-- bytes happen to be. This also makes an empty file impossible, so no separate
-- non-negative or non-empty check is needed.
ALTER TABLE "kyc_documents"
  ADD CONSTRAINT kyc_documents_bytes_are_pdf
  CHECK (substring(bytes from 1 for 5) = '\x255044462d'::bytea);

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "kyc_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kyc_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY kyc_documents_company_isolation ON "kyc_documents"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY kyc_documents_admin_access ON "kyc_documents"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
