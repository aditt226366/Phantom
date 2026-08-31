-- Bulk messaging: a broadcast, its audience, and the one column that marks a
-- message as part of one.
--
-- ---------------------------------------------------------------------------
-- A sent recipient is an ordinary message row. Nothing about bulk is parallel.
-- ---------------------------------------------------------------------------
--
-- messages.broadcast_id is the only thing that distinguishes a bulk send from
-- one an operator typed. Same status ladder, same delivery callbacks, same
-- retry path, same usage row, same thread - so "delivered" means exactly what
-- it already meant, and a customer who replies lands in the inbox beside
-- everyone else.
--
-- The alternative, a broadcast_messages table with its own statuses, would
-- have needed its own copy of the status ladder, its own webhook handling and
-- its own idea of what a retry is. Three places for Meta to tell us something
-- and two of them wrong.
--
-- ---------------------------------------------------------------------------
-- broadcast_recipients holds the audience BEFORE anybody has said send
-- ---------------------------------------------------------------------------
--
-- Which is the one thing message rows cannot do. PENDING is the status the
-- send worker claims by, so a draft's recipients sitting in `messages` would
-- be sent by the first worker that looked, with nobody having pressed
-- anything. A pre-send member on message_status would put a state describing
-- rows that are not messages yet into the enum every delivery callback and
-- every retry already reasons about.
--
-- So an imported list lives here through the mapping and confirm steps - and
-- through a browser refresh in the middle of them, which matters when the file
-- had ten thousand rows in it - and `message_id` below is where a recipient
-- becomes a message.
--
-- ---------------------------------------------------------------------------
-- template_id is NOT NULL, and that is Meta's rule in the schema
-- ---------------------------------------------------------------------------
--
-- A bulk recipient is cold. There is no open 24-hour window, so only an
-- approved template may be sent. sendPolicy already refuses free-form outside
-- the window; this column means a free-form broadcast is not merely disabled
-- but unrepresentable.
--
-- ON DELETE RESTRICT on the template and the number, where every other
-- reference here cascades. A broadcast is a record of what was sent to real
-- people, and deleting the template out from under it would leave a report
-- that cannot say what anybody received.
--
-- ---------------------------------------------------------------------------
-- The counts are stored, not derived
-- ---------------------------------------------------------------------------
--
-- "1,204 parsed, 11 unparseable, 38 duplicates, 92 already contacts, 4 opted
-- out" describes a file that no longer exists. It cannot be recomputed from
-- the recipients that survived it, and it is the audit of one upload.

CREATE TYPE "broadcast_status" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "broadcast_recipient_state" AS ENUM ('PENDING', 'SENT', 'SKIPPED');

-- ===========================================================================
-- COLUMNS ON EXISTING TABLES
-- ===========================================================================

ALTER TABLE "messages" ADD COLUMN "broadcast_id" TEXT;

-- Meta's 131026: this number cannot receive WhatsApp at all.
--
-- Deliberately a separate column from opted_out_at, though both exclude the
-- contact from every future broadcast. An opt-out is the customer's decision
-- and must be honoured for ever; this is a fact about a handset. Collapsing
-- them would make a report say a business's own customers had opted out when
-- what actually happened is that somebody typed a landline into a spreadsheet.
ALTER TABLE "contacts" ADD COLUMN "undeliverable_at" TIMESTAMPTZ(3);

-- Pacing, per tenant, admin-configurable. NOT the limit - the messaging tier
-- caps unique recipients per rolling 24 hours and is the real ceiling.
--
-- 800ms is roughly 75 messages a minute: slow enough that a bad template shows
-- up in the number's quality rating before the whole list has received it.
ALTER TABLE "companies" ADD COLUMN "broadcast_gap_ms" INTEGER NOT NULL DEFAULT 800;

-- ===========================================================================
-- BROADCASTS
-- ===========================================================================

CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "whatsapp_number_id" TEXT NOT NULL,
    "status" "broadcast_status" NOT NULL DEFAULT 'DRAFT',
    "column_mapping" JSONB,
    "gap_ms" INTEGER NOT NULL,
    "source_filename" TEXT,
    "parsed_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "existing_count" INTEGER NOT NULL DEFAULT 0,
    "opted_out_count" INTEGER NOT NULL DEFAULT 0,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "state" "broadcast_recipient_state" NOT NULL DEFAULT 'PENDING',
    "skip_reason" TEXT,
    "message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "broadcasts_company_id_created_at_idx"
  ON "broadcasts"("company_id", "created_at" DESC);
CREATE INDEX "broadcasts_company_id_status_idx"
  ON "broadcasts"("company_id", "status");

-- The drip walks this: one broadcast's pending rows, in a stable order.
CREATE INDEX "broadcast_recipients_company_id_broadcast_id_state_idx"
  ON "broadcast_recipients"("company_id", "broadcast_id", "state");

-- Deduping within one file happens in memory before the insert. This is the
-- backstop that does not depend on that having happened - a re-import into the
-- same broadcast is a constraint violation rather than a doubled send to a
-- real person.
CREATE UNIQUE INDEX "broadcast_recipients_broadcast_id_phone_e164_key"
  ON "broadcast_recipients"("broadcast_id", "phone_e164");

-- The report read: every recipient of one broadcast, grouped by status.
CREATE INDEX "messages_company_id_broadcast_id_status_idx"
  ON "messages"("company_id", "broadcast_id", "status");

-- ===========================================================================
-- FOREIGN KEYS
-- ===========================================================================

ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE. A broadcast records what real people were sent, and
-- deleting the template out from under it leaves a report that cannot say what
-- anybody received.
ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_whatsapp_number_id_fkey"
  FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull, like every other authorship column here.
ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: deleting a broadcast's bookkeeping must never delete messages a
-- customer has already received.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- CONSTRAINTS
-- ===========================================================================

-- Pacing has to be a pace. Zero would make the whole list one burst, which is
-- the behaviour the gap exists to prevent, and a negative delay is not a delay
-- BullMQ can schedule. The upper bound is a day, past which a broadcast is a
-- schedule rather than a send.
ALTER TABLE "companies"
  ADD CONSTRAINT companies_broadcast_gap_ms_sane
  CHECK (broadcast_gap_ms BETWEEN 1 AND 86400000);

ALTER TABLE "broadcasts"
  ADD CONSTRAINT broadcasts_gap_ms_sane
  CHECK (gap_ms BETWEEN 1 AND 86400000);

-- Counts describe a file and cannot be negative.
ALTER TABLE "broadcasts"
  ADD CONSTRAINT broadcasts_counts_non_negative
  CHECK (parsed_count >= 0 AND invalid_count >= 0 AND duplicate_count >= 0
     AND existing_count >= 0 AND opted_out_count >= 0 AND recipient_count >= 0);

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "broadcasts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "broadcasts" FORCE ROW LEVEL SECURITY;

CREATE POLICY broadcasts_company_isolation ON "broadcasts"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY broadcasts_admin_access ON "broadcasts"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "broadcast_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "broadcast_recipients" FORCE ROW LEVEL SECURITY;

CREATE POLICY broadcast_recipients_company_isolation ON "broadcast_recipients"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY broadcast_recipients_admin_access ON "broadcast_recipients"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
