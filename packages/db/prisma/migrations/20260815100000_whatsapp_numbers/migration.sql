-- The phone numbers behind a company's WhatsApp connection.
--
-- One WABA has many numbers, which is Meta's model, so this hangs off the
-- single WHATSAPP_CLOUD integration rather than relaxing its unique on
-- (company_id, provider). Relaxing that would move secrets between integration
-- rows, and integration_id is an AAD component - a decrypt-and-re-encrypt of
-- every credential, not an UPDATE.
--
-- Every column except the two ids is a cache of what Meta says. The refresh job
-- owns them; nothing here is typed by a person. metadata_refreshed_at being
-- null means never fetched, which is why UNKNOWN is a real status value rather
-- than standing in for "not asked yet".
--
-- The DDL below is Prisma's, unedited.

-- CreateEnum
CREATE TYPE "whatsapp_number_status" AS ENUM ('CONNECTED', 'PENDING', 'FLAGGED', 'RESTRICTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "whatsapp_quality_rating" AS ENUM ('GREEN', 'YELLOW', 'RED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_number" TEXT NOT NULL,
    "verified_name" TEXT,
    "quality_rating" "whatsapp_quality_rating" NOT NULL DEFAULT 'UNKNOWN',
    "status" "whatsapp_number_status" NOT NULL DEFAULT 'UNKNOWN',
    "messaging_tier" TEXT,
    "throughput_level" TEXT,
    "metadata_refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_numbers_company_id_created_at_idx" ON "whatsapp_numbers"("company_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_company_id_phone_number_id_key" ON "whatsapp_numbers"("company_id", "phone_number_id");

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements. 20260814220000_owner_default_privileges set default
-- privileges for whatsapp_owner, which runs migrations, so a table it creates
-- receives SELECT/INSERT/UPDATE/DELETE for app_runtime and app_admin - and
-- never TRUNCATE, which ignores RLS entirely.
--
-- FORCE, because whatsapp_owner owns this table and Postgres exempts an owner
-- from its own table's policies without it. That exemption is what makes
-- "the owner sees nothing without a company context" checkable.

ALTER TABLE "whatsapp_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_numbers" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_numbers_company_isolation ON "whatsapp_numbers"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_numbers_admin_access ON "whatsapp_numbers"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
