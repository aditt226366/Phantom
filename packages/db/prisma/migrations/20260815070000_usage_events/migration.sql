-- Usage events.
--
-- The DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written.
--
-- This table lands before anything generates much traffic, and that is the
-- point: usage that was never recorded cannot be backfilled, so Billing in a
-- later phase would start with a hole exactly as wide as the delay in creating
-- it. The integration verification path is its first emitter.
--
-- cost_minor, currency and price_version are NOT NULL with no default, which is
-- correct while the table is empty and forces every emitter to say what it
-- charged, in what currency, under which price list. A default of 0 would let a
-- caller that forgot to price something write a free row that looks deliberate.

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "cost_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "price_version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_events_company_id_occurred_at_idx" ON "usage_events"("company_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- A company's own billing record, so it is tenant-scoped like everything else.
-- The admin policy is what lets the overview total API calls and spend across
-- the installation; app_admin has no BYPASSRLS, so without it those two cards
-- would read zero rather than error.

ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_events_company_isolation ON "usage_events"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY usage_events_admin_access ON "usage_events"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
