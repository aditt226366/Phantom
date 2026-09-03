-- ===========================================================================
-- META'S CONVERSATION CHARGE, WHICH NOTHING WAS RECORDING
-- ===========================================================================
--
-- Meta bills per 24-hour conversation window, per category, and it is the
-- largest real cost in the product. Four usage kinds have existed for it since
-- Phase 4 - whatsapp.conversation.{marketing,utility,authentication,service} -
-- priced at zero like everything else, and nothing ever wrote one.
--
-- Not for want of the data. `payload.ts` has parsed `pricing.billable` and
-- `pricing.category` off the status callback the whole time, and
-- `conversationUsageKind` exists to map a category to a kind and was called
-- from a test and nowhere else. The webhook read the values and dropped them on
-- the floor.
--
-- ---------------------------------------------------------------------------
-- Its own table, because Meta's conversation is not ours
-- ---------------------------------------------------------------------------
--
-- `conversations` is a thread between a contact and one of our numbers and it
-- lasts for ever. Meta's conversation is a BILLING WINDOW of 24 hours: one
-- thread running for a month is thirty of them, each with its own id, category
-- and charge. Columns on `conversations` would keep the newest window and lose
-- the twenty-nine before it, which is the bill.
--
-- ---------------------------------------------------------------------------
-- The unique index is the whole design
-- ---------------------------------------------------------------------------
--
-- One window produces dozens of status callbacks - sent, delivered and read,
-- for every message in it - each carrying the same conversation id and the same
-- pricing block. UNIQUE (company_id, meta_conversation_id) is what turns those
-- into one charge, and it is also what makes the backfill safe to run twice
-- over the same stored payloads.
--
-- The matching usage_events row is deduped on the same id, by the constraint
-- that table already carries.

CREATE TABLE "whatsapp_conversation_charges" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,

    -- Meta's own id for the window: the unit they bill and dedupe on.
    "meta_conversation_id" TEXT NOT NULL,

    -- Verbatim from Meta, never mapped on the way in. Nullable because the
    -- pricing block is absent on some statuses, and a window recorded without
    -- its category is still worth more than no row - it says the window
    -- existed. Only a category conversationUsageKind recognises produces a
    -- charge.
    "category" TEXT,
    "pricing_model" TEXT,

    -- What Meta said about whether they are charging. A free-tier service
    -- window is real and is not a charge; only true writes a usage row.
    "billable" BOOLEAN NOT NULL DEFAULT false,

    -- The message whose callback first reported this window, for tracing a
    -- charge back to something a person can open.
    "first_wamid" TEXT,

    -- Meta's instant, never ours. A backfill reading payloads stored months ago
    -- must land on the original moment, or a quarter's spend moves to the day
    -- somebody ran the script.
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    -- No DEFAULT: @updatedAt means Prisma writes it on every update, and a
    -- database default here is drift the diff reports for ever.
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_conversation_charges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whatsapp_conversation_charges"
  ADD CONSTRAINT "whatsapp_conversation_charges_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per window per company. See the header: this is what makes dozens of
-- callbacks into one charge.
-- Named as Prisma names it, which is NOT the obvious concatenation: Postgres
-- caps an identifier at 63 characters and Prisma truncates to match, so
-- "…_meta_conversation_id_key" becomes "…_meta_conversation__key". Spelling it
-- the obvious way is permanent drift that `migrate diff` reports on every run -
-- and a drift check people learn to ignore is worse than none.
CREATE UNIQUE INDEX "whatsapp_conversation_charges_company_id_meta_conversation__key"
  ON "whatsapp_conversation_charges"("company_id", "meta_conversation_id");

-- Leads with company_id, per rule 2. Serves "this month's windows", which is
-- what a spend report reads.
CREATE INDEX "whatsapp_conversation_charges_company_id_occurred_at_idx"
  ON "whatsapp_conversation_charges"("company_id", "occurred_at" DESC);

-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin, and never TRUNCATE.

ALTER TABLE "whatsapp_conversation_charges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_conversation_charges" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_conversation_charges_company_isolation
  ON "whatsapp_conversation_charges"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_conversation_charges_admin_access
  ON "whatsapp_conversation_charges"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
