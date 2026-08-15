-- The credential vault.
--
-- The DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written: RLS, forced, one policy per role, on all three tables.
--
-- No GRANT statements. 20260814220000_owner_default_privileges points
-- ALTER DEFAULT PRIVILEGES at whatsapp_owner, which runs migrations, so these
-- tables receive SELECT/INSERT/UPDATE/DELETE for app_runtime and app_admin on
-- creation - and never TRUNCATE, which would ignore RLS entirely.
--
-- No app_resolver grant either. Nothing here is read before authentication;
-- these tables are reached only from a session that already resolved.

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('GOOGLE_SHEETS', 'WHATSAPP_CLOUD', 'META_ADS');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('CONNECTED', 'NOT_CONNECTED');

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "label" TEXT NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'NOT_CONNECTED',
    "last_verified_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_secrets" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_verifications" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integrations_company_id_provider_key" ON "integrations"("company_id", "provider");

-- CreateIndex
CREATE INDEX "integration_secrets_company_id_integration_id_idx" ON "integration_secrets"("company_id", "integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_secrets_integration_id_key_key" ON "integration_secrets"("integration_id", "key");

-- CreateIndex
CREATE INDEX "integration_verifications_company_id_created_at_idx" ON "integration_verifications"("company_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_verifications" ADD CONSTRAINT "integration_verifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_verifications" ADD CONSTRAINT "integration_verifications_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- The composite index each table needs is already above and is not decoration:
-- schema-invariants requires an index whose FIRST column is company_id, because
-- that is the only shape Postgres can use for the policy's own lookup.
--
-- integration_secrets carries company_id itself rather than reaching it through
-- integrations. A policy that had to join to find the company would be a policy
-- that can be got wrong, and it would run on every row the vault touches.

ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_company_isolation ON "integrations"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY integrations_admin_access ON "integrations"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "integration_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_secrets" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_secrets_company_isolation ON "integration_secrets"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY integration_secrets_admin_access ON "integration_secrets"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "integration_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_verifications_company_isolation ON "integration_verifications"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY integration_verifications_admin_access ON "integration_verifications"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
