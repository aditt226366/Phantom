-- ===========================================================================
-- META ADS, ON THE TENANT'S OWN META ACCOUNT
-- ===========================================================================
--
-- Amendment A3. Each client connects THEIR OWN Meta account and their
-- credentials live per-tenant in the integrations section, exactly as the
-- WhatsApp app secret and verify token already do. Nothing is shared, and this
-- app never holds a credential that reaches across tenants.
--
-- What that deletes is Advanced Access and App Review for `ads_management` -
-- two to four weeks of Meta dependency on the critical path, with no fallback
-- if the review had failed. What it costs is that token lifetime stops being
-- our internal detail and becomes a tenant-visible operational fact, which is
-- why the first thing in this migration is an expiry column.
--
-- ---------------------------------------------------------------------------
-- Why expiry is a column and not a lookup
-- ---------------------------------------------------------------------------
--
-- A stored token's expiry could be asked of Meta on demand - debug_token
-- returns it. That is the wrong shape for the thing it has to drive. The badge
-- and the reconnect prompt are rendered on every page load of the integrations
-- section, a Graph call per render is a rate limit waiting to happen, and the
-- one moment the answer matters most is the moment the token has ALREADY
-- expired, when the call to ask about it fails too.
--
-- So it is recorded when the token is stored and read locally. A3 says plainly
-- that adding this later would be a backfill on encrypted rows, which is the
-- one shape of migration this table makes genuinely unpleasant.

-- ---------------------------------------------------------------------------
-- 1. The vault learns when a credential stops working
-- ---------------------------------------------------------------------------

-- Nullable, and null is a real answer rather than a missing one: most
-- credentials in this system do not expire at all. A Google private key, a
-- verify token and an app secret are valid until somebody revokes them, and
-- writing a far-future date into those rows would invent an expiry the
-- provider never issued.
ALTER TABLE "integration_secrets"
  ADD COLUMN "expires_at" TIMESTAMPTZ(3);

-- No column GRANT for it, and that is worth stating, because the instinct here
-- is wrong in both directions and this migration was written the wrong way
-- first.
--
-- C10 was a new column on `unroutable_webhooks` going ungranted for eight
-- commits, and the lesson recorded from it is that a column grant lives in
-- pg_attribute.attacl, per column, and is implied by nothing. That is true -
-- but only of a table where the role holds COLUMN grants and nothing else,
-- which is precisely what makes unroutable_webhooks special: app_runtime may
-- read three of its columns and must not be able to enumerate the rest.
--
-- app_runtime holds TABLE-level SELECT/INSERT/UPDATE/DELETE on
-- integration_secrets, from the default privileges in 20260814220000. A
-- table-level grant covers every column the table has and every column it will
-- ever have, so a GRANT here would confer nothing that is not already held.
--
-- It would also cost something. COLUMN_GRANTS in packages/db/scripts/
-- invariants.mjs is an allowlist of grants that are deliberately NARROW - the
-- resolver's six columns, and the three unroutable_webhooks columns the upsert
-- forces. Three redundant entries in it is how the narrow grants that matter
-- stop standing out, which is the only thing that list is for.

-- ---------------------------------------------------------------------------
-- 2. Where a contact came from
-- ---------------------------------------------------------------------------

-- Reusing conversation_source rather than declaring a contact_source beside
-- it. The vocabulary is identical - a thread and the person in it arrived the
-- same way - and a second enum could only ever disagree with the first, in the
-- direction where a dashboard counts one and a report counts the other.
--
-- Nullable with NO default, deliberately. Every contact in this database
-- predates anything recording this, and defaulting them to INBOUND would be a
-- claim: it would tell a tenant that six months of contacts arrived
-- organically when nothing ever asked. Null means "not recorded", which is
-- true, and it is distinguishable from a contact we know came in cold.
ALTER TABLE "contacts"
  ADD COLUMN "source" "conversation_source";

-- No column GRANT, for the reason given above the expires_at column:
-- app_runtime holds table-level privileges on contacts, which cover every
-- column it will ever have.

-- Serves the dashboard's "where your leads came from" card, which groups the
-- contact book by this column. Leads with company_id, per rule 2.
CREATE INDEX "contacts_company_id_source_idx"
  ON "contacts"("company_id", "source");

-- ---------------------------------------------------------------------------
-- 3. An ad account the tenant chose
-- ---------------------------------------------------------------------------

CREATE TYPE "meta_campaign_status" AS ENUM ('PAUSED', 'ACTIVE', 'ARCHIVED');

CREATE TYPE "meta_campaign_objective" AS ENUM (
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES'
);

CREATE TABLE "meta_ad_accounts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,

    -- Meta's own identifier, stored WITH its act_ prefix, because that is the
    -- form every Graph path takes and normalising it on the way out is one
    -- more place to forget.
    "meta_ad_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    -- The account's own currency, from Meta, and the reason spend is never
    -- summed across accounts. There is no exchange rate in this system and
    -- one must not appear at render time.
    "currency" TEXT NOT NULL,
    "timezone_name" TEXT,
    "account_status" INTEGER,

    -- The Facebook Page the click-to-WhatsApp ad posts from. A CTWA ad cannot
    -- exist without one, and the Page is what carries the WhatsApp number, so
    -- selecting an account without one leaves a builder that can draw a
    -- campaign it can never create.
    "page_id" TEXT,
    "page_name" TEXT,

    -- The number Meta says that Page is linked to, as OUR row.
    --
    -- Nullable because the link is validated against Meta rather than assumed,
    -- and a Page whose linked number is not one of ours is a real and common
    -- state - an agency running ads for a business whose WhatsApp lives
    -- somewhere else. ON DELETE SET NULL rather than CASCADE: losing a number
    -- must not delete the ad account and its spend history with it.
    "whatsapp_number_id" TEXT,

    -- The number Meta reported, verbatim, even when it matches nothing here.
    -- Without it the mismatch is unexplainable: the page says "this Page is
    -- linked to a different number" and cannot say which.
    "linked_phone_e164" TEXT,

    -- How far the insights sync has read, as a date in the account's own
    -- timezone. Null means it has never run.
    "insights_synced_through" DATE,
    "insights_synced_at" TIMESTAMPTZ(3),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    -- No DEFAULT: @updatedAt means Prisma writes it on every update, and a
    -- database default here is drift the diff reports for ever.
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meta_ad_accounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "meta_ad_accounts"
  ADD CONSTRAINT "meta_ad_accounts_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_accounts"
  ADD CONSTRAINT "meta_ad_accounts_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_accounts"
  ADD CONSTRAINT "meta_ad_accounts_whatsapp_number_id_fkey"
  FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per Meta ad account per company. A tenant selecting the same account
-- twice is a duplicate, not a second account, and the sync would then write
-- every day's spend twice.
CREATE UNIQUE INDEX "meta_ad_accounts_company_id_meta_ad_account_id_key"
  ON "meta_ad_accounts"("company_id", "meta_ad_account_id");

CREATE INDEX "meta_ad_accounts_company_id_created_at_idx"
  ON "meta_ad_accounts"("company_id", "created_at" DESC);

CREATE INDEX "meta_ad_accounts_company_id_integration_id_idx"
  ON "meta_ad_accounts"("company_id", "integration_id");

ALTER TABLE "meta_ad_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_ad_accounts" FORCE ROW LEVEL SECURITY;

CREATE POLICY meta_ad_accounts_company_isolation
  ON "meta_ad_accounts"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY meta_ad_accounts_admin_access
  ON "meta_ad_accounts"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. A campaign, which is created PAUSED and never any other way
-- ---------------------------------------------------------------------------
--
-- The default is the safety property of this whole phase. A campaign created
-- ACTIVE starts spending the tenant's money the instant the builder's form
-- posts - before anybody has read back what they drew, and with a budget
-- somebody typed into a field they were still thinking about. There is no undo
-- for money Meta has already spent.
--
-- So the row's default is PAUSED, Meta is asked to create it PAUSED, and going
-- ACTIVE is a separate deliberate act. Two mechanisms rather than one, because
-- either alone is a single point of failure and only one of them is ours.

CREATE TABLE "meta_campaigns" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,

    -- Meta's id for the campaign we created. NOT NULL: a row here means a
    -- campaign exists at Meta. A local draft that was never created there
    -- would be a second lifecycle to reason about, and the thing a tenant
    -- wants to save half-finished is the FORM, which is not a database
    -- concern.
    "meta_campaign_id" TEXT NOT NULL,

    "name" TEXT NOT NULL,
    "objective" "meta_campaign_objective" NOT NULL,
    "status" "meta_campaign_status" NOT NULL DEFAULT 'PAUSED',

    -- Millionths of one unit of the ad account's currency, matching usage
    -- events. Meta takes minor units; the conversion happens at the boundary
    -- so that nothing in this database is denominated in paise for one row and
    -- rupees for another.
    "daily_budget_micros" BIGINT,
    -- Copied from the ad account at creation rather than joined at read time.
    -- An account cannot change currency, but a campaign's spend must stay
    -- readable as a self-contained fact, and every reader of this table is
    -- forbidden from adding two currencies together.
    "currency" TEXT NOT NULL,

    -- When somebody deliberately turned it on. Null until then, and it stays
    -- set once it is - pausing a live campaign does not un-publish it, and a
    -- report asking "has this ever run" must not be answered by its current
    -- state.
    "published_at" TIMESTAMPTZ(3),
    "published_by_user_id" TEXT,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meta_campaigns_pkey" PRIMARY KEY ("id"),

    -- An ACTIVE campaign carries the instant it was turned on.
    --
    -- The same shape as conversations_driver_has_its_instant: a claim and the
    -- moment it became true belong together, or the audit question "who
    -- started this spending and when" has no answer for exactly the campaigns
    -- where it is asked.
    CONSTRAINT "meta_campaigns_active_has_been_published"
      CHECK ("status" <> 'ACTIVE' OR "published_at" IS NOT NULL)
);

ALTER TABLE "meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_ad_account_id_fkey"
  FOREIGN KEY ("ad_account_id") REFERENCES "meta_ad_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_published_by_user_id_fkey"
  FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "meta_campaigns_company_id_meta_campaign_id_key"
  ON "meta_campaigns"("company_id", "meta_campaign_id");

CREATE INDEX "meta_campaigns_company_id_created_at_idx"
  ON "meta_campaigns"("company_id", "created_at" DESC);

CREATE INDEX "meta_campaigns_company_id_ad_account_id_idx"
  ON "meta_campaigns"("company_id", "ad_account_id");

ALTER TABLE "meta_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_campaigns" FORCE ROW LEVEL SECURITY;

CREATE POLICY meta_campaigns_company_isolation
  ON "meta_campaigns"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY meta_campaigns_admin_access
  ON "meta_campaigns"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. What Meta says a campaign spent, per day
-- ---------------------------------------------------------------------------
--
-- Per campaign per day, and the day is Meta's in the ad account's timezone
-- rather than ours. An account set to America/Los_Angeles has a different
-- Tuesday from a platform day computed at +05:30, and re-syncing a window
-- under our own day boundary would move spend between days on every run.

CREATE TABLE "meta_ad_insights" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,

    -- Meta's campaign id as text, NOT a foreign key to meta_campaigns.
    --
    -- Deliberate. A tenant's ad account contains campaigns they built in Meta's
    -- own tools years before connecting to us, and those campaigns spend money
    -- that belongs in "cost this month". A foreign key would force us either to
    -- drop that spend or to invent meta_campaigns rows for campaigns this
    -- product did not create and cannot manage - and a row in that table means
    -- "we made this", which would stop being true.
    "meta_campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT,

    -- The advertising day, in the ad account's timezone. DATE and not a
    -- timestamp: Meta reports a day, not an instant, and storing midnight in
    -- some zone invites somebody to render it as one.
    "date" DATE NOT NULL,

    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,

    -- Millionths of one unit of `currency`. BIGINT because a campaign that has
    -- run for a year in a minor-unit-heavy currency overflows an integer, and
    -- because the value must never pass through a JSON number - cost_micros
    -- past 2^53 silently drops its last digits, which is the worst possible
    -- way to discover a column's type.
    "spend_micros" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,

    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meta_ad_insights_pkey" PRIMARY KEY ("id"),

    -- Meta restates a day's figures as attribution windows close, so a day is
    -- re-read and overwritten several times. None of the three may go
    -- backwards into nonsense.
    CONSTRAINT "meta_ad_insights_counts_are_not_negative"
      CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "spend_micros" >= 0)
);

ALTER TABLE "meta_ad_insights"
  ADD CONSTRAINT "meta_ad_insights_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_insights"
  ADD CONSTRAINT "meta_ad_insights_ad_account_id_fkey"
  FOREIGN KEY ("ad_account_id") REFERENCES "meta_ad_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per campaign per day per account. This is what makes the sync
-- idempotent: Meta restates recent days as attribution windows close, and a
-- re-read must UPDATE the day rather than add a second copy of it. Without it
-- a nightly sync over a 28-day window multiplies every figure by 28.
--
-- Named as Prisma names it: Postgres caps an identifier at 63 characters and
-- Prisma truncates to match, so the obvious spelling is permanent drift.
CREATE UNIQUE INDEX "meta_ad_insights_company_id_ad_account_id_meta_campaig_date_key"
  ON "meta_ad_insights"("company_id", "ad_account_id", "meta_campaign_id", "date");

-- "This month's spend", which is what the dashboard card reads.
CREATE INDEX "meta_ad_insights_company_id_date_idx"
  ON "meta_ad_insights"("company_id", "date" DESC);

ALTER TABLE "meta_ad_insights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_ad_insights" FORCE ROW LEVEL SECURITY;

CREATE POLICY meta_ad_insights_company_isolation
  ON "meta_ad_insights"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY meta_ad_insights_admin_access
  ON "meta_ad_insights"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. The click that started a conversation
-- ---------------------------------------------------------------------------
--
-- Meta attaches a `referral` block to the FIRST inbound message of a
-- conversation that began with a click-to-WhatsApp ad. It carries the ad's id
-- and a click id, and it arrives exactly once - on that message and never
-- again. A webhook that reads it and drops it has lost the only join between
-- money spent and a person who replied, permanently and with no way to
-- reconstruct it: Meta's Insights API reports spend per ad and has no idea
-- which WhatsApp thread it produced.
--
-- Its own table rather than columns on conversations, for the reason the
-- conversation-charge table gives about billing windows. One contact can click
-- three different ads over a month; columns would keep the newest and lose the
-- two that actually converted.

CREATE TABLE "meta_ad_referrals" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,

    "conversation_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    -- The inbound message that carried the block. The unique index below is on
    -- this, so a redelivered webhook does not write a second referral.
    "message_id" TEXT NOT NULL,

    -- Meta's click id. The join key to an ad click, and the value their
    -- attribution reporting is keyed on.
    "ctwa_clid" TEXT,
    -- The ad id. This is what joins a conversation to spend, through
    -- meta_ad_insights.meta_campaign_id once the ad's campaign is known.
    "source_id" TEXT,
    -- "ad" or "post". Kept verbatim: an organic post referral is not an ad
    -- click and must not be counted as one in a cost-per-lead figure.
    "source_type" TEXT,
    "source_url" TEXT,

    -- The ad's own copy, as Meta sent it. What makes a referral legible to a
    -- person reading the thread six weeks later, when the ad itself has been
    -- edited or deleted and Meta will no longer say what it said.
    "headline" TEXT,
    "body" TEXT,

    -- Meta's instant, never ours, for the same reason the charge table gives.
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "meta_ad_referrals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "meta_ad_referrals"
  ADD CONSTRAINT "meta_ad_referrals_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_referrals"
  ADD CONSTRAINT "meta_ad_referrals_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_referrals"
  ADD CONSTRAINT "meta_ad_referrals_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ad_referrals"
  ADD CONSTRAINT "meta_ad_referrals_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One referral per message. Meta redelivers a webhook it did not get a 200
-- for, and the redelivery carries the same referral block.
CREATE UNIQUE INDEX "meta_ad_referrals_company_id_message_id_key"
  ON "meta_ad_referrals"("company_id", "message_id");

-- Joining spend to leads: "how many people did this ad bring".
CREATE INDEX "meta_ad_referrals_company_id_source_id_idx"
  ON "meta_ad_referrals"("company_id", "source_id");

CREATE INDEX "meta_ad_referrals_company_id_occurred_at_idx"
  ON "meta_ad_referrals"("company_id", "occurred_at" DESC);

ALTER TABLE "meta_ad_referrals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_ad_referrals" FORCE ROW LEVEL SECURITY;

CREATE POLICY meta_ad_referrals_company_isolation
  ON "meta_ad_referrals"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY meta_ad_referrals_admin_access
  ON "meta_ad_referrals"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- No GRANT statements anywhere in this migration. Default privileges from
-- 20260814220000 cover app_runtime and app_admin on the four new tables, and
-- never TRUNCATE; the two added columns sit on tables where those roles already
-- hold table-level privileges. See the note above "expires_at" for why adding
-- redundant column grants would be worse than adding none.
