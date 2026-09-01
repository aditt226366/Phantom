-- A record of every webhook Meta delivered.
--
-- ---------------------------------------------------------------------------
-- processed_at is what stops dedupe from losing messages
-- ---------------------------------------------------------------------------
--
-- The obvious design is ON CONFLICT DO NOTHING on (company_id, delivery_key):
-- Meta redelivers, we have seen it, drop it. That silently discards messages.
--
-- "Already recorded" is not "already processed". If the first delivery inserted
-- the row and enqueued a job, and that job was then lost - worker killed
-- mid-restart, Redis flushed, attempts exhausted - Meta's retry is the only
-- remaining copy of that customer's message, and dropping it loses the message
-- for good.
--
-- So the conflict path reads processed_at. Still null means the work never
-- finished, and the redelivery is enqueued again. Dedupe prevents double
-- processing; it must not prevent recovery.
--
-- delivery_count exists for the same reason Message.send_attempt does: BullMQ
-- keeps failed job ids for a day, so re-enqueueing a recovery under the id the
-- first attempt used would be silently dropped.
--
-- ---------------------------------------------------------------------------
-- processed_at is also the only way a silent failure becomes visible
-- ---------------------------------------------------------------------------
--
-- Without it, an event that was received and enqueued and never handled looks
-- exactly like one handled successfully, and there is nothing to query. With
-- it, the health check is one line - and note the bound is passed in rather
-- than written as now(), for the reason 20260815130000 records at length:
--
--   SELECT count(*) FROM whatsapp_webhook_events
--    WHERE processed_at IS NULL AND created_at < $1;   -- now() minus 5 minutes
--
-- That is what Phase 7's dashboard will read.
--
-- ---------------------------------------------------------------------------
-- The payload is text, not jsonb
-- ---------------------------------------------------------------------------
--
-- The signature was computed over the raw bytes, so the raw form is the only
-- one that can be re-verified later - which is the entire point of keeping a
-- forensic record. jsonb would reorder keys and normalise numbers, and the row
-- would then prove nothing about what Meta actually sent. Parse on read.
--
-- Capped at 64 KiB, which is generous - a large batch of statuses is a few KB.
-- The route truncates and sets payload_truncated; the CHECK below is the
-- backstop that does not depend on it having done so. A truncated payload can
-- still be read but can no longer be signature-verified, which is why the flag
-- is a column rather than a marker buried in the text.
--
-- ---------------------------------------------------------------------------
-- Retention, named now rather than designed in Phase 12
-- ---------------------------------------------------------------------------
--
-- This table holds every inbound message body twice - here and in messages.body
-- - so it doubles the PII surface and grows without bound. Intended retention
-- is 30 days.
--
-- The prune cannot run from the worker: it connects as app_runtime with no
-- company context, so a cross-company DELETE matches zero rows, succeeds, and
-- looks exactly like "nothing to prune". It is the same enumerate-web-side
-- fan-out that integration repair and vault rotation already use - the admin
-- client lists companies, one job per company, each deleting inside its own
-- withCompany scope. Naming that here costs a sentence; discovering it in
-- Phase 12 costs a design pass.
--
-- The (company_id, created_at DESC) index is what that prune reads.
--
-- The DDL below is Prisma's, unedited.

-- CreateTable
CREATE TABLE "whatsapp_webhook_events" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "payload_truncated" BOOLEAN NOT NULL DEFAULT false,
    "delivery_count" INTEGER NOT NULL DEFAULT 1,
    "processed_at" TIMESTAMP(3),
    "skipped_reason" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_company_id_created_at_idx" ON "whatsapp_webhook_events"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_company_id_processed_at_idx" ON "whatsapp_webhook_events"("company_id", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_webhook_events_company_id_delivery_key_key" ON "whatsapp_webhook_events"("company_id", "delivery_key");

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- CONSTRAINTS
-- ===========================================================================

ALTER TABLE "whatsapp_webhook_events"
  ADD CONSTRAINT whatsapp_webhook_events_payload_within_cap
  CHECK (octet_length(payload) <= 65536);

-- ===========================================================================
-- SECURITY
-- ===========================================================================

ALTER TABLE "whatsapp_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_webhook_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_webhook_events_company_isolation ON "whatsapp_webhook_events"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_webhook_events_admin_access ON "whatsapp_webhook_events"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
