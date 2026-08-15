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
-- cost_micros is millionths of a currency unit, not minor units. Phase 7 prices
-- AI calls below a cent each, and a paise-denominated column rounds a $0.0003
-- reply to zero: a thousand conversations then sum to nothing and the invoice
-- is quietly short. BIGINT because INTEGER tops out near 2,147 currency units
-- per row, which a day of ad spend passes.
--
-- It is nullable, and an unpriced event writes NULL rather than 0. Zero claims
-- something was free; NULL records that no claim was made. Summed they are
-- indistinguishable and the total looks equally authoritative either way, so
-- the count of unpriced rows is reported beside it instead.
--
-- dedupe_key exists because DEFAULT_JOB_OPTIONS sets attempts: 5. A job that
-- emits its usage event and then fails emits again on every retry - five rows
-- for one provider call, in the table that becomes an invoice.

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "cost_micros" BIGINT,
    "currency" TEXT,
    "price_version" INTEGER NOT NULL,
    "unpriced_reason" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_company_id_dedupe_key_key" ON "usage_events"("company_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "usage_events_company_id_occurred_at_idx" ON "usage_events"("company_id", "occurred_at" DESC);

-- CreateIndex
--
-- The admin overview counts across every company since midnight. The composite
-- above cannot serve that: it leads with company_id, so a query with no company
-- predicate seq-scans the table that grows fastest.
--
-- occurred_at alone. A (kind, occurred_at) index reads as more useful and is
-- worse here: with kind leading, a range on occurred_at cannot seek and the
-- planner falls back to scanning the whole index. EXPLAIN is what caught that.
CREATE INDEX "usage_events_occurred_at_idx" ON "usage_events"("occurred_at" DESC);

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
