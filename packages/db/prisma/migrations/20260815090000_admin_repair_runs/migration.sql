-- A record that a platform-wide repair run happened.
--
-- The DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written.
--
-- Global, like the rest of the admin space. It belongs to the installation
-- rather than to any company, which is why it carries no company_id and is
-- named in GLOBAL_TABLES.

-- CreateTable
CREATE TABLE "admin_repair_runs" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT,
    "total_companies" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_repair_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_repair_runs_started_at_idx" ON "admin_repair_runs"("started_at" DESC);

-- AddForeignKey
ALTER TABLE "admin_repair_runs" ADD CONSTRAINT "admin_repair_runs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- app_runtime gets nothing here, exactly as for the other admin tables. A
-- tenant request has no business knowing that a platform maintenance run is
-- under way, and the worker does not write here either — run progress is
-- derived from integration_verifications rather than counted, so no cross-role
-- write is needed and no grant has to exist for one.
--
-- The default privileges from 20260814220000 would otherwise hand app_runtime
-- CRUD on this table simply for having been created by whatsapp_owner, so the
-- revoke is not decoration. schema-invariants asserts it.

REVOKE ALL ON TABLE "admin_repair_runs" FROM app_runtime;
