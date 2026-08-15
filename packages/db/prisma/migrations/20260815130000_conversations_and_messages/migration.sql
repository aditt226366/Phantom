-- Contacts, conversations, and the messages between them.
--
-- The core of the phase: what a customer said, what we said back, and whether
-- we are still allowed to say anything.
--
-- ---------------------------------------------------------------------------
-- Which vocabularies get to be enums
-- ---------------------------------------------------------------------------
--
-- The test is who defines the set. Ours can be an enum, because adding a member
-- is our decision and arrives with a migration. Meta's cannot, because adding a
-- member is their decision and arrives without warning.
--
--   direction, status, source, error_source   ours          -> enum
--   type                                      Meta's        -> text
--
-- message.type is the one that matters. The vocabulary is text, image,
-- document, audio, video, sticker, location, contacts, interactive, button,
-- order, system, reaction, and Meta adds to it. As an enum, "Meta shipped a new
-- message type" becomes a failed write on an inbound webhook - the worst place
-- in the system to fail, because no user is watching, the delivery retries
-- until Meta gives up, and the customer's message is simply lost. As text it
-- stores as itself and the thread renders an unsupported-type placeholder.
--
-- message_status is Meta-adjacent but still ours: the webhook parser maps
-- Meta's strings onto this ladder and ignores any it does not recognise, so an
-- unmapped value never reaches the column. PENDING has no Meta equivalent.
--
-- ---------------------------------------------------------------------------
-- Two ordering decisions
-- ---------------------------------------------------------------------------
--
-- occurred_at is the column the thread orders by, and created_at is explicitly
-- not it. Inbound carries Meta's unix-seconds timestamp; outbound is stamped
-- when we accept it; created_at is when the worker inserted the row. A delayed
-- or retried delivery makes those diverge by minutes, and a thread ordered by
-- created_at then shows an order the customer never saw.
--
-- Meta's granularity is one second, so ties are real rather than theoretical.
-- The thread index carries id as its last column so every ordered read has a
-- deterministic tiebreak.
--
-- ---------------------------------------------------------------------------
-- The unique on conversations is a concurrency control, not a nicety
-- ---------------------------------------------------------------------------
--
-- (company_id, contact_id, whatsapp_number_id) is the conflict target the
-- inbound upsert needs. Without it, two webhook deliveries for the same contact
-- arriving together both find no conversation and both insert, and the customer
-- ends up with two half-threads whose 24-hour windows disagree.
--
-- ---------------------------------------------------------------------------
-- Indexes are for the queries that run
-- ---------------------------------------------------------------------------
--
--   conversations (company_id, last_message_at DESC)   the inbox list
--   conversations (company_id, window_expires_at)      canSend, and Phase 9's
--                                                      closing-windows card
--   messages (company_id, conversation_id,
--             occurred_at DESC, id)                    the thread
--   messages (company_id, status)                      the send worker's claim
--
-- Each verified with EXPLAIN ANALYZE as app_runtime inside a company context -
-- not as the owner, because the RLS predicate is ANDed into the query and
-- changes the plan.
--
-- Three of the four are chosen freely by the planner. The fourth is not, and
-- the reason is a call convention rather than a missing index:
--
--   SELECT ... WHERE window_expires_at BETWEEN now() AND now() + interval '1 hour'
--
-- estimates at rows=1 however much data is present, so the planner never
-- reaches for the range index and sequentially scans instead. Passing the two
-- bounds as parameters computed in the application uses the histogram and picks
-- the index. Measured at 200k conversations across 10 companies:
--
--   now() inline       Seq Scan                                 13.017 ms
--   explicit bounds    conversations_company_id_window_expires_at_idx   0.205 ms
--
-- Sixty-three times, on a query whose whole purpose is to be cheap enough to
-- put on a dashboard. So: never range on now() in SQL against this column.
-- Compute the bounds in TypeScript and bind them. canSend is unaffected - it
-- reads one conversation by id - but Phase 9's "closing within the hour" card
-- is exactly this query, and would have shipped as a sequential scan.
--
-- ---------------------------------------------------------------------------
-- SetNull on two foreign keys, unlike everything else here
-- ---------------------------------------------------------------------------
--
-- conversations.assigned_user_id and messages.sent_by_user_id are SET NULL.
-- Every other relation in this schema cascades, correctly, because the child is
-- meaningless without its parent. These are not that: cascading would mean
-- deleting an employee deletes the conversations they handled and the messages
-- they sent to customers. The thread is the company's record of what a customer
-- was told, and it outlives the person who typed it.
--
-- The DDL below is Prisma's, unedited.

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DELIVERED', 'READ');

-- CreateEnum
CREATE TYPE "conversation_source" AS ENUM ('INBOUND', 'CAMPAIGN', 'ADS_CLICK_TO_WHATSAPP', 'MANUAL');

-- CreateEnum
CREATE TYPE "message_failure_source" AS ENUM ('META', 'POLICY');

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "phone_e164" TEXT,
    "profile_name" TEXT,
    "display_name" TEXT,
    "opted_out_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "whatsapp_number_id" TEXT NOT NULL,
    "source" "conversation_source" NOT NULL DEFAULT 'INBOUND',
    "last_inbound_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" TEXT,
    "window_expires_at" TIMESTAMP(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "assigned_user_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "direction" "message_direction" NOT NULL,
    "status" "message_status" NOT NULL DEFAULT 'PENDING',
    "type" TEXT NOT NULL,
    "wamid" TEXT,
    "body" TEXT,
    "template_payload" JSONB,
    "error_source" "message_failure_source",
    "error_code" INTEGER,
    "error_title" TEXT,
    "send_attempt" INTEGER NOT NULL DEFAULT 0,
    "sent_by_user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contacts_company_id_created_at_idx" ON "contacts"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_company_id_opted_out_at_idx" ON "contacts"("company_id", "opted_out_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_company_id_wa_id_key" ON "contacts"("company_id", "wa_id");

-- CreateIndex
CREATE INDEX "conversations_company_id_last_message_at_idx" ON "conversations"("company_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_company_id_window_expires_at_idx" ON "conversations"("company_id", "window_expires_at");

-- CreateIndex
CREATE INDEX "conversations_company_id_assigned_user_id_idx" ON "conversations"("company_id", "assigned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_company_id_contact_id_whatsapp_number_id_key" ON "conversations"("company_id", "contact_id", "whatsapp_number_id");

-- CreateIndex
CREATE INDEX "messages_company_id_conversation_id_occurred_at_id_idx" ON "messages"("company_id", "conversation_id", "occurred_at" DESC, "id");

-- CreateIndex
CREATE INDEX "messages_company_id_status_idx" ON "messages"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "messages_company_id_wamid_key" ON "messages"("company_id", "wamid");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_whatsapp_number_id_fkey" FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: 20260814220000_owner_default_privileges already gives
-- app_runtime and app_admin CRUD on tables the owner creates, and never
-- TRUNCATE. FORCE, because the owner is otherwise exempt from its own tables'
-- policies and "the owner sees nothing without a company context" would stop
-- being checkable.

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;

CREATE POLICY contacts_company_isolation ON "contacts"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY contacts_admin_access ON "contacts"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;

CREATE POLICY conversations_company_isolation ON "conversations"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY conversations_admin_access ON "conversations"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY messages_company_isolation ON "messages"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY messages_admin_access ON "messages"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
