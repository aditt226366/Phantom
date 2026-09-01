-- The dashboard's numbers, computed once a minute instead of once a page load.
--
-- ===========================================================================
-- WHY THIS TABLE EXISTS
-- ===========================================================================
--
-- The tenant dashboard shows a dozen figures, and every one of them is an
-- aggregate over the two tables that grow fastest: messages and conversations.
-- Computed at render time that is six sequential scans of messages per page
-- load, per viewer, per refresh - on the one page people leave open on a second
-- monitor all day.
--
-- The alternative is not caching the page. A cached page is stale in a way
-- nobody can see; a rollup is stale in a way the page can print. So the numbers
-- are recomputed on a schedule, the moment they were computed is stored beside
-- them, and the dashboard says how old they are rather than implying they are
-- live.
--
-- ===========================================================================
-- WHY ONE ROW PER COMPANY, AND NOT A ROW PER METRIC
-- ===========================================================================
--
-- Because the freshness stamp has to cover everything it sits above.
--
-- Split across several tables - a scalars table, a per-currency table, a
-- per-source table - a refresh can succeed for some and fail for others, and
-- the page then prints one "as of" line over a mixture of two different
-- moments. That is worse than a stale page, because it looks consistent.
--
-- One row, one upsert, one computed_at. Everything on the page was true at the
-- same instant or none of it was. The two figures that are genuinely a set
-- rather than a scalar - spend per currency, failures per Meta error code -
-- are jsonb columns on that row for the same reason, and each says below why
-- its shape is what it is.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ===========================================================================
--
-- Four of the dashboard's cards are not rolled up, and their absence is a
-- decision rather than an omission:
--
--   windows closing in the next hour   a range seek on
--                                      (company_id, window_expires_at) that
--                                      returns a handful of rows, and a
--                                      minute of staleness is the difference
--                                      between acting inside a window and
--                                      missing it
--   number health                      whatsapp_numbers holds single digits
--                                      per company
--   templates awaiting approval        indexed on (company_id, status), and
--                                      also single digits
--   recent conversations               an index-ordered LIMIT on
--                                      (company_id, last_message_at DESC)
--
-- The rule those four share: a rollup is for aggregates whose cost grows with
-- history. A seek that returns ten rows does not become cheaper for being a
-- minute old, and it does become wrong.

CREATE TABLE "dashboard_rollups" (
    -- The primary key IS the tenant key. One row per company, which is what
    -- makes the upsert below a single statement with no arbiter to choose.
    "company_id" TEXT NOT NULL,

    -- When these figures were true. Rendered on the page, never inferred from
    -- updated_at - there is no updated_at, because a row whose only meaning is
    -- "as of" should not carry a second timestamp that could disagree.
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    -- The two platform-day boundaries the counts below were taken against.
    --
    -- Stored rather than recomputed by the reader, and this is the column that
    -- catches the fault a freshness check cannot see. At 00:04 IST a rollup
    -- computed at 23:59 is five minutes old - perfectly fresh - and its
    -- "new today" is a complete count of YESTERDAY presented as a partial count
    -- of today. The reader compares this against the current boundary and says
    -- so. See countedDayIsCurrent in @whatsapp-os/core/dashboard.
    "day_start" TIMESTAMPTZ(3) NOT NULL,
    "month_start" TIMESTAMPTZ(3) NOT NULL,

    -- ---------------------------------------------------------------------
    -- Messages
    -- ---------------------------------------------------------------------

    "messages_total" INTEGER NOT NULL DEFAULT 0,
    "messages_inbound" INTEGER NOT NULL DEFAULT 0,
    "messages_outbound" INTEGER NOT NULL DEFAULT 0,

    -- The delivery ladder, outbound only, one column per member.
    --
    -- Columns rather than a jsonb map, unlike the two maps below, and the
    -- difference is whose vocabulary it is. message_status is OUR enum: adding
    -- a member is already a migration, so a column per member costs nothing
    -- extra and buys a typed read and a checkable sum. Meta's error codes and
    -- ISO currency codes are open sets that arrive without notice, and a
    -- column per member there would mean a migration every time Meta invents a
    -- number.
    --
    -- These seven sum to messages_outbound by construction, which the refresh's
    -- test asserts against SQL ground truth - an arithmetic slip in the FILTER
    -- clauses is otherwise completely silent.
    "outbound_pending" INTEGER NOT NULL DEFAULT 0,
    "outbound_unconfirmed" INTEGER NOT NULL DEFAULT 0,
    "outbound_held" INTEGER NOT NULL DEFAULT 0,
    "outbound_sent" INTEGER NOT NULL DEFAULT 0,
    "outbound_failed" INTEGER NOT NULL DEFAULT 0,
    "outbound_delivered" INTEGER NOT NULL DEFAULT 0,
    "outbound_read" INTEGER NOT NULL DEFAULT 0,

    -- Why the failures failed, as {"131049": 8, "131026": 3, "POLICY": 2}.
    --
    -- Keyed by Meta's own code, and grouped into headings in TypeScript rather
    -- than here. bulk/limits.ts already holds the four back-off codes and the
    -- undeliverable one, and the send worker consults it on every refusal; a
    -- second copy of those numbers inside a SQL string is a second place to
    -- update when Meta adds one, and the copy that would not be updated is the
    -- one no test covers.
    --
    -- Storing the codes rather than the groups also means re-grouping is a
    -- redeploy instead of a rescan of messages for every company.
    --
    -- Our own refusals carry no Meta code - canSend declined, the window shut
    -- between enqueue and send - and key on 'POLICY' instead, so they are
    -- counted rather than dropped. A breakdown whose total disagreed with the
    -- failed count beside it would read as an arithmetic bug in the page.
    "failures_by_code" JSONB NOT NULL DEFAULT '{}',

    -- ---------------------------------------------------------------------
    -- Conversations and contacts
    -- ---------------------------------------------------------------------

    "conversations_total" INTEGER NOT NULL DEFAULT 0,
    "conversations_new_today" INTEGER NOT NULL DEFAULT 0,

    -- The reply rate's two halves, and the reason they are a pair.
    --
    -- "Replied" cannot be a proportion of messages: one customer answering
    -- after five reminders is one reply, not one in five. It is a proportion of
    -- THREADS the business opened - conversations carrying at least one
    -- outbound message, and of those, the ones where the customer wrote back
    -- afterwards. The page states that denominator beside the bar, because it
    -- differs from the two bars above it and an unlabelled third rate reads as
    -- though it shared theirs.
    --
    -- "Afterwards" is load-bearing: a thread the customer started, that we
    -- replied to, is not them replying to us. The refresh compares the newest
    -- inbound against the OLDEST outbound for exactly that reason.
    "conversations_messaged" INTEGER NOT NULL DEFAULT 0,
    "conversations_replied" INTEGER NOT NULL DEFAULT 0,

    -- Where conversations came from, as {"INBOUND": 40, "CAMPAIGN": 12}.
    --
    -- jsonb despite conversation_source being our enum, unlike the ladder
    -- above, because this one is read as a distribution and rendered by
    -- iterating it. A column per member would have the chart's component
    -- naming each member in source, which is where a member added later goes
    -- missing silently.
    "conversations_by_source" JSONB NOT NULL DEFAULT '{}',

    "contacts_total" INTEGER NOT NULL DEFAULT 0,
    "contacts_new_today" INTEGER NOT NULL DEFAULT 0,

    -- ---------------------------------------------------------------------
    -- Money
    -- ---------------------------------------------------------------------

    -- Spend since month_start, as {"INR": "4000000000", "USD": "50000000"}.
    --
    -- A MAP, and never a total. There is no exchange rate anywhere in this
    -- system and one must not be invented at render time: adding Rs 4,000 to
    -- $50 produces 4,050 of nothing. A map cannot be accidentally summed by a
    -- component written in a hurry, which a single numeric column invites.
    --
    -- The values are STRINGS. cost_micros is a bigint, jsonb numbers are IEEE
    -- doubles, and a currency total that silently drops its last digits past
    -- 2^53 is the worst possible way to discover the column's type. Strings in,
    -- BigInt out, no float in the path.
    "cost_by_currency" JSONB NOT NULL DEFAULT '{}',

    -- Events with no price, counted separately and shown when non-zero.
    --
    -- usage_events.cost_micros is nullable precisely so that unpriced is not
    -- free: SUM ignores nulls, so these lower no total - they just have to be
    -- reported, or the month's spend reads as complete when part of it was
    -- never priced.
    "cost_unpriced_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dashboard_rollups_pkey" PRIMARY KEY ("company_id")
);

-- ===========================================================================
-- KEYS
-- ===========================================================================

-- CASCADE, like every other tenant table. A rollup outliving its company is a
-- row nothing can read and nothing will ever refresh.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT "dashboard_rollups_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- CONSTRAINTS
-- ===========================================================================

-- Counts describe things that happened and cannot be negative.
--
-- Cheap here and not cheap to notice otherwise: a subtraction in the refresh
-- that goes the wrong way renders as a bar drawn off the left of its track,
-- which looks like a CSS bug and gets chased in the wrong file.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_counts_non_negative
  CHECK (
    messages_total >= 0 AND messages_inbound >= 0 AND messages_outbound >= 0
    AND outbound_pending >= 0 AND outbound_unconfirmed >= 0
    AND outbound_held >= 0 AND outbound_sent >= 0 AND outbound_failed >= 0
    AND outbound_delivered >= 0 AND outbound_read >= 0
    AND conversations_total >= 0 AND conversations_new_today >= 0
    AND conversations_messaged >= 0 AND conversations_replied >= 0
    AND contacts_total >= 0 AND contacts_new_today >= 0
    AND cost_unpriced_count >= 0
  );

-- The delivery ladder accounts for every outbound message, exactly once.
--
-- This is the invariant the whole card rests on: the breakdown is presented as
-- a partition of everything the tenant tried to send, so a FILTER clause that
-- overlaps or misses a status makes the chart quietly not add up. Enforced in
-- the database rather than trusted to the query, because the query is one
-- statement and this is the only thing that would notice it drifting.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_ladder_partitions_outbound
  CHECK (
    outbound_pending + outbound_unconfirmed + outbound_held + outbound_sent
    + outbound_failed + outbound_delivered + outbound_read = messages_outbound
  );

-- And the two directions account for every message.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_directions_partition_total
  CHECK (messages_inbound + messages_outbound = messages_total);

-- A thread cannot have replied without having been messaged.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_replied_within_messaged
  CHECK (conversations_replied <= conversations_messaged);

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "dashboard_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_rollups" FORCE ROW LEVEL SECURITY;

CREATE POLICY dashboard_rollups_company_isolation ON "dashboard_rollups"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY dashboard_rollups_admin_access ON "dashboard_rollups"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
