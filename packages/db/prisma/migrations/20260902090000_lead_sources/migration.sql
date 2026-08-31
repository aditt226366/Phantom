-- Lead sources: a bound spreadsheet, an action, and the record that makes a
-- second WhatsApp message to the same person impossible.
--
-- ---------------------------------------------------------------------------
-- The unique index is the feature. Everything else is bookkeeping.
-- ---------------------------------------------------------------------------
--
-- A poll reads a spreadsheet somebody else is editing, on a schedule, for ever.
-- Every mechanism above the database - a cursor, an anchor, a set of hashes
-- held in memory - is an optimisation that can be wrong, and the failure mode
-- of being wrong is a real customer receiving the same message twice. That
-- cannot be un-sent, and no apology undoes it.
--
-- So the guarantee lives here, in one partial index, checked inside the
-- transaction that creates the message. Not in the worker, not in a Set, not in
-- a "have we seen this" query run before the write - every one of those has a
-- window between the check and the insert, and a poll running every thirty
-- seconds beside a retrying job will find it.
--
--   UNIQUE (company_id, spreadsheet_id, row_hash)
--
-- ---------------------------------------------------------------------------
-- Per spreadsheet, not per binding, and that is a decision
-- ---------------------------------------------------------------------------
--
-- Two bindings on the same sheet with different templates would each want to
-- message every row. Keyed per binding they both would, and the customer hears
-- from the business twice for one enquiry.
--
-- Keyed per spreadsheet the second binding sends nothing - which is wrong in
-- the other direction, but wrong in the direction that can be fixed by a person
-- rather than by an apology. It is also not silent: the conflicting row is
-- counted as a duplicate on the binding that lost, and its page says so.
--
-- ---------------------------------------------------------------------------
-- The action is a column, not an assumption
-- ---------------------------------------------------------------------------
--
-- Today a binding sends an approved template. The flow builder (A1) and the AI
-- layer (A2) are both meant to become alternative actions on the same binding,
-- so the kind is an enum column with its config in jsonb beside it, and the
-- CHECK below ties them together: a TEMPLATE binding must name a template, and
-- an action nobody has declared cannot be written at all.
--
-- template_id is ON DELETE RESTRICT for the reason broadcasts.template_id is:
-- this is a record of what real people were sent, and deleting the template out
-- from under it leaves a report that cannot say what anybody received.

CREATE TYPE "lead_source_action" AS ENUM ('TEMPLATE');
CREATE TYPE "lead_source_status" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');
CREATE TYPE "lead_source_row_state" AS ENUM ('SENT', 'SKIPPED');

-- ===========================================================================
-- LEAD SOURCES
-- ===========================================================================

CREATE TABLE "lead_sources" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,

    "name" TEXT NOT NULL,

    -- Google's own id, parsed out of whatever the tenant pasted. The tab is
    -- stored by TITLE because that is what the values API takes as a range;
    -- the gid is kept beside it only to link back into Google at the right
    -- tab, and is deliberately not the thing we read by - a renamed tab is a
    -- visible error on the binding, where a silently different tab is not.
    "spreadsheet_id" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "sheet_gid" INTEGER,

    "action" "lead_source_action" NOT NULL DEFAULT 'TEMPLATE',
    -- The mapping and anything else the action needs. jsonb because the
    -- variable count comes from the template rather than from us, exactly as
    -- broadcasts.column_mapping does.
    "action_config" JSONB NOT NULL,

    "template_id" TEXT,
    "whatsapp_number_id" TEXT NOT NULL,

    "status" "lead_source_status" NOT NULL DEFAULT 'ACTIVE',
    "poll_interval_seconds" INTEGER NOT NULL DEFAULT 30,

    -- The cursor, and the anchor that says the sheet is the one we left.
    --
    -- The count alone is wrong in both directions with no error either way: a
    -- deletion puts it past the end of the sheet and the binding never sends
    -- again, and a mid-sheet insert shifts a sent row into its place while the
    -- new one above it is never looked at. The anchor is a hash of the last row
    -- seen, so an append leaves it where it was and anything structural does
    -- not. See newRowsSince in @whatsapp-os/core/leads-server.
    "cursor_count" INTEGER NOT NULL DEFAULT 0,
    "cursor_anchor" TEXT,

    -- What the binding's page reports. Counters rather than aggregates over
    -- lead_source_rows, because rejects and duplicates never become rows -
    -- there is nothing to count them from afterwards.
    "rows_seen" INTEGER NOT NULL DEFAULT 0,
    "rows_sent" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped" INTEGER NOT NULL DEFAULT 0,
    "rows_rejected" INTEGER NOT NULL DEFAULT 0,
    "rows_duplicate" INTEGER NOT NULL DEFAULT 0,

    -- Rejects by reason, as {"unparseable_phone": 12, "missing_phone": 3}.
    --
    -- Aggregated rather than stored per row on purpose. A broken mapping
    -- rejects every row of a growing sheet on every poll, so a table of them
    -- grows without bound - and it would be a second copy of phone numbers we
    -- decided not to keep. "12 rows had a number nobody can be reached on" is
    -- the whole of what a tenant can act on.
    "reject_reasons" JSONB NOT NULL DEFAULT '{}',

    "last_polled_at" TIMESTAMPTZ(3),
    "last_sent_at" TIMESTAMPTZ(3),
    -- The sentence the page shows when the sheet cannot be read. Already
    -- scrubbed by the adapter before it gets here.
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(3),

    -- Quota back-off. A poll that finds this in the future does nothing.
    --
    -- Sheets meters reads per minute per PROJECT, so one tenant's binding can
    -- exhaust the allowance every other tenant's binding depends on. Backing
    -- off in the database rather than only in Redis means the state survives a
    -- worker restart, and means the binding's page can say why nothing is
    -- happening instead of looking broken.
    "backoff_until" TIMESTAMPTZ(3),

    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- ROWS THAT BECAME MESSAGES
-- ===========================================================================
--
-- One row per lead the system has acted on. Not a copy of the spreadsheet -
-- only the hash, the number it resolved to, and what happened - because the
-- spreadsheet is the tenant's and keeping a shadow of it is data retention
-- nobody asked for and nobody could justify when asked what we hold.

CREATE TABLE "lead_source_rows" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "lead_source_id" TEXT NOT NULL,

    -- Denormalised from the binding so the unique below can be per
    -- spreadsheet. A join cannot carry a unique index.
    "spreadsheet_id" TEXT NOT NULL,

    -- sha256 over the E.164 number and the template's variable values,
    -- length-prefixed and version-tagged. Deliberately not the row's position:
    -- an insert at the top shifts every row below it, and a position-sensitive
    -- hash re-sends the entire sheet to everybody on it.
    "row_hash" TEXT NOT NULL,

    "phone_e164" TEXT NOT NULL,

    "state" "lead_source_row_state" NOT NULL DEFAULT 'SENT',
    -- Why nothing was sent. Null unless state is SKIPPED.
    "skip_reason" TEXT,

    -- The message this became. Null when the row was skipped.
    "message_id" TEXT,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_rows_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- INDEXES
-- ===========================================================================

CREATE INDEX "lead_sources_company_id_created_at_idx"
  ON "lead_sources"("company_id", "created_at" DESC);
CREATE INDEX "lead_sources_company_id_status_idx"
  ON "lead_sources"("company_id", "status");

-- The whole point. Checked inside the transaction that writes the message, so
-- there is no window between deciding to send and having sent.
--
-- A SKIPPED row occupies a hash too, and that is correct: a contact who opted
-- out must not be reconsidered on the next poll, and re-examining them every
-- thirty seconds for ever would be the alternative.
CREATE UNIQUE INDEX "lead_source_rows_company_id_spreadsheet_id_row_hash_key"
  ON "lead_source_rows"("company_id", "spreadsheet_id", "row_hash");

-- The binding's live feed: its most recent rows, newest first.
CREATE INDEX "lead_source_rows_company_id_lead_source_id_created_at_idx"
  ON "lead_source_rows"("company_id", "lead_source_id", "created_at" DESC);

-- ===========================================================================
-- FOREIGN KEYS
-- ===========================================================================

ALTER TABLE "lead_sources"
  ADD CONSTRAINT "lead_sources_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, as broadcasts.template_id is. A lead source is a record of what
-- real people were sent, and deleting the template out from under it leaves a
-- report that cannot say what anybody received.
ALTER TABLE "lead_sources"
  ADD CONSTRAINT "lead_sources_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lead_sources"
  ADD CONSTRAINT "lead_sources_whatsapp_number_id_fkey"
  FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lead_sources"
  ADD CONSTRAINT "lead_sources_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_source_rows"
  ADD CONSTRAINT "lead_source_rows_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE from the binding, and this one is worth pausing on. Deleting a
-- binding deletes its idempotency records, so re-binding the same sheet
-- messages everybody on it again.
--
-- That is the honest behaviour rather than an oversight: a tenant who deletes a
-- binding and creates a new one has asked for a new binding, and a hidden
-- record that silently suppressed their first campaign would be worse than a
-- warning on the delete button - which is where this is handled.
ALTER TABLE "lead_source_rows"
  ADD CONSTRAINT "lead_source_rows_lead_source_id_fkey"
  FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: deleting a binding's bookkeeping must never delete messages a
-- customer has already received.
ALTER TABLE "lead_source_rows"
  ADD CONSTRAINT "lead_source_rows_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- CONSTRAINTS
-- ===========================================================================

-- The discriminated field, in the schema. A TEMPLATE binding must name a
-- template; when a second action arrives it gets its own arm here, and the
-- absence of one is a migration that fails rather than a binding that polls a
-- sheet and does nothing with what it finds.
ALTER TABLE "lead_sources"
  ADD CONSTRAINT lead_sources_action_has_its_target
  CHECK (
    (action = 'TEMPLATE' AND template_id IS NOT NULL)
  );

-- Ten seconds is the floor because Sheets meters per project: at six reads a
-- minute per binding, fifty bindings consume a 300/min allowance on their own
-- and take every other tenant down with them. A day is the ceiling, past which
-- a lead source is a monthly report. Mirrors POLL_INTERVAL_MIN/MAX_SECONDS.
ALTER TABLE "lead_sources"
  ADD CONSTRAINT lead_sources_poll_interval_sane
  CHECK (poll_interval_seconds BETWEEN 10 AND 86400);

ALTER TABLE "lead_sources"
  ADD CONSTRAINT lead_sources_counts_non_negative
  CHECK (rows_seen >= 0 AND rows_sent >= 0 AND rows_skipped >= 0
     AND rows_rejected >= 0 AND rows_duplicate >= 0 AND cursor_count >= 0);

-- A skipped row explains itself, and a sent one does not pretend to.
--
-- Without this a row can be SENT with a skip_reason, or SKIPPED with neither a
-- reason nor a message - both of which render as a blank cell in a report
-- somebody is reading to find out why a customer was never contacted.
ALTER TABLE "lead_source_rows"
  ADD CONSTRAINT lead_source_rows_state_matches_reason
  CHECK (
    (state = 'SENT' AND skip_reason IS NULL)
    OR (state = 'SKIPPED' AND skip_reason IS NOT NULL AND message_id IS NULL)
  );

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "lead_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_sources" FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_sources_company_isolation ON "lead_sources"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY lead_sources_admin_access ON "lead_sources"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "lead_source_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_source_rows" FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_source_rows_company_isolation ON "lead_source_rows"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY lead_source_rows_admin_access ON "lead_source_rows"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
