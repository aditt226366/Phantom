-- Inbound media, stored once per file.
--
-- Meta's media URLs expire in minutes and need the access token, so storing the
-- URL means broken images tomorrow. The bytes are fetched on receipt.
--
-- ---------------------------------------------------------------------------
-- Dedupe is per company, and that is a tenancy decision
-- ---------------------------------------------------------------------------
--
-- Content-addressed rather than keyed on Meta's media id: the same image
-- forwarded to fifty contacts arrives as fifty ids and one hash.
--
-- The unique is (company_id, sha256), never sha256 alone. Global dedupe is the
-- obvious optimisation, and the reasons to refuse it are about tenancy rather
-- than storage: one company's cost would depend on another's traffic; the row
-- would be jointly owned, so deleting one company's data either takes the
-- other's bytes or leaves them holding a row they cannot account for; and a
-- company could learn from an insert's timing that another tenant already holds
-- a file it is uploading.
--
-- ---------------------------------------------------------------------------
-- The size cap is enforced three times, on purpose
-- ---------------------------------------------------------------------------
--
--   1. During the download. The fetch is aborted the moment the running byte
--      count crosses 5 MiB. Not from content-length, which is a remote value we
--      would be trusting, and not after the fact, which means a 200 MB response
--      was already resident in the worker before anyone looked.
--   2. In the row that results: state SKIPPED, skipped_reason 'over_max_size',
--      byte_size still recorded so the thread can say "6.2 MB, not stored". The
--      webhook that carried it succeeds; nothing retries.
--   3. Here, as a CHECK. The backstop for both of the above, in the same spirit
--      as validating a file type by magic bytes rather than by its extension -
--      the check that does not depend on the caller having behaved.
--
-- The second CHECK ties byte_size to the bytes actually present, so the
-- metadata cannot quietly disagree with the content it describes.
--
-- CHECK constraints are invisible to Prisma, so they live only here and do not
-- appear in schema.prisma. That also means `migrate diff` will not report their
-- absence if someone drops them - which is what the tests are for.
--
-- ---------------------------------------------------------------------------
-- STORAGE EXTERNAL is load-bearing
-- ---------------------------------------------------------------------------
--
-- The read path slices this column with substring() to stream it without
-- materialising 5 MB in the request. Under the default EXTENDED, TOAST
-- compresses the value and a slice must decompress from the beginning, so the
-- streaming becomes a fiction that looks like it works. JPEG, MP4 and PDF do
-- not compress meaningfully anyway, so the setting costs nothing.
--
-- The DDL below is Prisma's, unedited.

-- CreateEnum
CREATE TYPE "media_state" AS ENUM ('PENDING', 'STORED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "media_id" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_media" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_name" TEXT,
    "byte_size" INTEGER NOT NULL,
    "state" "media_state" NOT NULL DEFAULT 'PENDING',
    "skipped_reason" TEXT,
    "storage_backend" TEXT NOT NULL DEFAULT 'postgres',
    "storage_key" TEXT,
    "bytes" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_media_company_id_created_at_idx" ON "whatsapp_media"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_media_company_id_state_idx" ON "whatsapp_media"("company_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_media_company_id_sha256_key" ON "whatsapp_media"("company_id", "sha256");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "whatsapp_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_media" ADD CONSTRAINT "whatsapp_media_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- STORAGE AND CONSTRAINTS
-- ===========================================================================

ALTER TABLE "whatsapp_media" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

ALTER TABLE "whatsapp_media"
  ADD CONSTRAINT whatsapp_media_bytes_within_cap
  CHECK (bytes IS NULL OR octet_length(bytes) <= 5242880);

ALTER TABLE "whatsapp_media"
  ADD CONSTRAINT whatsapp_media_byte_size_matches
  CHECK (bytes IS NULL OR octet_length(bytes) = byte_size);

ALTER TABLE "whatsapp_media"
  ADD CONSTRAINT whatsapp_media_byte_size_non_negative
  CHECK (byte_size >= 0);

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "whatsapp_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_media" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_media_company_isolation ON "whatsapp_media"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_media_admin_access ON "whatsapp_media"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
