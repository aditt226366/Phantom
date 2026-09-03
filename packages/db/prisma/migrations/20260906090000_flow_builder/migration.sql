-- The rule-based flow builder: four tables, a version pin, and an append-only log.
--
-- ===========================================================================
-- WHAT THE SHAPE IS FOR
-- ===========================================================================
--
-- A tenant draws a decision tree. A customer taps buttons and the tree
-- advances. No model is involved at any point, so the same input always
-- produces the same next node - which is the product, not an implementation
-- detail, and it is also what keeps this answerable to Meta's January 2026 ban
-- on general-purpose chatbots without an argument.
--
-- Two facts about WhatsApp shape every table below.
--
-- Interactive messages - reply buttons and lists - need no Meta approval, which
-- is what makes a visual builder possible at all: a flow can be edited and
-- republished in seconds. They are also free-form, so they only work INSIDE the
-- 24-hour customer service window. An approved template with quick-reply
-- buttons is therefore the only legal way to start a flow and the only way to
-- resume one whose window has lapsed.
--
-- And a button never expires in the chat. A customer scrolls up three days and
-- taps "Yes" on a message from a flow that finished on Tuesday. What arrives is
-- the id we wrote, unchanged, with no way to invalidate it - which is why the
-- ids encode the run and the node, and why flow_runs can recognise a tap for a
-- position it has already left. See packages/core/src/flows/button-id.ts.
--
-- ===========================================================================
-- WHY FOUR TABLES AND NOT TWO
-- ===========================================================================
--
-- flows holds a name and a pointer at what is live. flow_versions holds the
-- trees. The split exists for one reason: a run has to be pinned to the tree it
-- started on.
--
-- A customer is three questions deep. The tenant opens the builder, deletes the
-- branch that customer is standing on, and publishes. If a run read the flow's
-- current graph, the next tap would name a node that no longer exists, and the
-- only honest thing to do with it would be nothing. Pinning means every run in
-- flight finishes on the tree it began on, and the cost - a fix to a live flow
-- does not reach the customers currently inside it - is the right way round:
-- they are mid-conversation, and changing the questions underneath somebody
-- mid-conversation is worse.
--
-- flow_runs is one customer's position. flow_run_steps is what happened, one
-- row at a time, and it is the only record of what a specific customer was
-- actually asked and what they actually answered.

-- ===========================================================================
-- ENUMS
-- ===========================================================================

CREATE TYPE "flow_run_status" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'HANDED_OFF', 'FAILED');

CREATE TYPE "flow_step_kind" AS ENUM ('STARTED', 'SENT', 'ADVANCED', 'ACTION', 'PAUSED', 'RESUMED', 'DECLINED', 'ENDED', 'FAILED');

CREATE TYPE "lead_score" AS ENUM ('HOT', 'WARM', 'COLD');

-- The second member of the column Phase 6 built with one and said would gain
-- another. Wiring it here is what proves the discriminated shape was right: a
-- binding keeps its sheet, its tab, its mapping, its cleaning, its cursor and
-- its idempotency index, and only the last step changes.
ALTER TYPE "lead_source_action" ADD VALUE 'FLOW';

-- ===========================================================================
-- COLUMNS ON EXISTING TABLES
-- ===========================================================================

-- An interactive message is a new message TYPE on the existing send path, not a
-- second send path. The worker branches on which payload column is populated,
-- exactly as it already branches on template_payload, and the status ladder,
-- the delivery callbacks, the retry, the thread and the usage row needed no
-- change at all.
--
-- Stored rather than rebuilt from the flow version on demand, because the ids
-- inside it name a run and a node and are the only record of what one specific
-- customer was offered. A flow archived a year from now must not make an old
-- thread unreadable.
ALTER TABLE "messages" ADD COLUMN "interactive_payload" JSONB;

-- Lead temperature, which has been an honest empty state on the dashboard
-- since Phase 7 and stops being one here.
--
-- NULL is not COLD. A report counting unscored contacts as cold would tell a
-- business its entire contact book was uninterested, which is the same class of
-- false number that pending.ts exists to prevent.
ALTER TABLE "contacts"
  ADD COLUMN "lead_score" "lead_score",
  ADD COLUMN "lead_score_at" TIMESTAMPTZ(3),
  ADD COLUMN "lead_score_run_id" TEXT,
  -- Free text the tenant chose, read only with the contact that carries it.
  -- An array rather than a join table because nothing counts them across
  -- contacts and nothing renames one.
  ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- A binding names a flow VERSION, never a flow.
--
-- A run pins the version it started on, and a binding naming the flow would put
-- every row it read into whatever happened to be published that minute - so a
-- tenant republishing mid-import would split one afternoon's leads across two
-- different trees, with nothing to say so. Repointing is a deliberate edit.
ALTER TABLE "lead_sources" ADD COLUMN "flow_version_id" TEXT;

-- ===========================================================================
-- TABLES
-- ===========================================================================

CREATE TABLE "flows" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    -- Which version customers are being put into. NULL means nothing is live.
    --
    -- A pointer here rather than a flag on the version, so "which one is live"
    -- has exactly one answer. Two published versions is not a state this schema
    -- can represent, and publishing is moving this pointer.
    "published_version_id" TEXT,

    -- Set rather than deleted. A flow with runs behind it is a record of what
    -- customers were told, and deleting it would take the runs with it.
    "archived_at" TIMESTAMPTZ(3),

    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_versions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,

    -- Monotonic per flow. "Version 3" is a thing people say to each other.
    "version" INTEGER NOT NULL,

    -- The tree, validated by validateFlow in @whatsapp-os/core/flows.
    --
    -- jsonb rather than a table of nodes and a table of edges, and the reason is
    -- the pinning: a version is immutable once published and is read whole on
    -- every advance. Normalised, "the tree as it was" becomes a join across two
    -- tables that would both have to be versioned too, and immutability stops
    -- being a property of one row.
    "graph" JSONB NOT NULL,

    -- The entry node's template, lifted out of the graph so it can carry a
    -- foreign key. RESTRICT below: deleting a template a published flow opens
    -- with would leave that flow with no legal entry point, and it would fail
    -- when a customer arrived rather than when somebody pressed delete.
    "entry_template_id" TEXT NOT NULL,

    -- NULL while this is a draft. Set once, when it goes live.
    "published_at" TIMESTAMPTZ(3),
    "published_by_user_id" TEXT,

    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flow_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_runs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,

    -- The pin. Never updated after insert.
    "flow_version_id" TEXT NOT NULL,

    "conversation_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,

    -- A duplicate of conversation_id, present only while the run is live.
    --
    -- -------------------------------------------------------------------
    -- A redundant column, because the guarantee is not expressible otherwise
    -- -------------------------------------------------------------------
    --
    -- A conversation must never be in two flows at once: two runs would both
    -- send, both wait, and the customer would receive two questions and be able
    -- to answer only one. But a conversation may hold many FINISHED runs,
    -- because a customer coming back next month is ordinary.
    --
    -- That is a partial unique index - unique on the conversation WHERE the
    -- status is live - and schema.prisma cannot express one. A hand-written
    -- partial index would show as permanent drift on every `migrate diff`,
    -- which is a check people learn to ignore.
    --
    -- Postgres treats NULLs as distinct, the same property that lets
    -- messages.wamid be unique while many pending sends carry none. So this
    -- holds the conversation while the run is live and NULL once it is not, and
    -- an ordinary unique index does the work. The two CHECKs below are what
    -- keep it honest; without them this is a column that can quietly disagree
    -- with the one beside it.
    "active_conversation_id" TEXT,

    "status" "flow_run_status" NOT NULL DEFAULT 'ACTIVE',

    -- Where the customer is standing. NULL once the run has ended.
    "current_node_id" TEXT,

    -- What the flow has collected, as {"want": "shoes"}.
    --
    -- Per run rather than on the contact: these are answers to THIS
    -- conversation's questions. A "size" collected in a shoe flow is not a fact
    -- about the person that next month's flow should read as still true.
    "variables" JSONB NOT NULL DEFAULT '{}',

    -- Steps over the run's whole life. MAX_STEPS_PER_RUN reads this.
    "step_count" INTEGER NOT NULL DEFAULT 0,

    -- Why it stopped, when it stopped badly. Already safe to show a tenant.
    "last_error" TEXT,

    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the window shut on it. NULL unless it is or has been paused.
    "paused_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_run_steps" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "flow_run_id" TEXT NOT NULL,

    -- Position in the run, from 1. Unique per run below, so two writers cannot
    -- both believe they were step 4.
    "seq" INTEGER NOT NULL,

    "kind" "flow_step_kind" NOT NULL,

    -- Text, not a foreign key: nodes live inside a version's jsonb, and a step
    -- has to stay readable after the flow it belonged to was archived.
    "node_id" TEXT,

    -- The choice key the customer tapped, on an ADVANCED step.
    "choice" TEXT,

    -- The message this step sent. NULL for everything that sends nothing.
    "message_id" TEXT,

    -- Everything else, keyed by what the step was: the variables an ADVANCED
    -- step set, the actions an ACTION step performed, the reason a DECLINED
    -- step declined.
    "detail" JSONB NOT NULL DEFAULT '{}',

    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_run_steps_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- INDEXES
-- ===========================================================================

CREATE UNIQUE INDEX "flows_published_version_id_key" ON "flows"("published_version_id");
CREATE INDEX "flows_company_id_created_at_idx" ON "flows"("company_id", "created_at" DESC);

CREATE UNIQUE INDEX "flow_versions_company_id_flow_id_version_key" ON "flow_versions"("company_id", "flow_id", "version");
CREATE INDEX "flow_versions_company_id_flow_id_version_idx" ON "flow_versions"("company_id", "flow_id", "version" DESC);

-- One live run per conversation. See active_conversation_id above.
CREATE UNIQUE INDEX "flow_runs_company_id_active_conversation_id_key" ON "flow_runs"("company_id", "active_conversation_id");
-- The thread's own history, and the inbox asking whether a thread is automated.
CREATE INDEX "flow_runs_company_id_conversation_id_started_at_idx" ON "flow_runs"("company_id", "conversation_id", "started_at" DESC);
-- The flow's report: every run of one flow, grouped by how it ended.
CREATE INDEX "flow_runs_company_id_flow_id_status_idx" ON "flow_runs"("company_id", "flow_id", "status");

CREATE UNIQUE INDEX "flow_run_steps_company_id_flow_run_id_seq_key" ON "flow_run_steps"("company_id", "flow_run_id", "seq");
CREATE INDEX "flow_run_steps_company_id_flow_run_id_seq_idx" ON "flow_run_steps"("company_id", "flow_run_id", "seq" DESC);

-- The dashboard's lead-temperature card, grouped by score.
CREATE INDEX "contacts_company_id_lead_score_idx" ON "contacts"("company_id", "lead_score");

-- ===========================================================================
-- KEYS
-- ===========================================================================

ALTER TABLE "flows" ADD CONSTRAINT "flows_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flows" ADD CONSTRAINT "flows_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NO ACTION, and it is the one referential action here that is not obvious.
--
-- flows and flow_versions reference each other. The cycle has to be broken
-- somewhere or two cascades chase one another: a version's flow_id cascades, so
-- deleting a flow deletes its versions, and this side does nothing rather than
-- trying to delete the flow back.
ALTER TABLE "flows" ADD CONSTRAINT "flows_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "flow_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_entry_template_id_fkey" FOREIGN KEY ("entry_template_id") REFERENCES "whatsapp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: a version with runs pinned to it is the only description of what
-- those customers were asked, so it outlives any tidying of old drafts.
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_version_id_fkey" FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_flow_run_id_fkey" FOREIGN KEY ("flow_run_id") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, like every other message reference: deleting a message must not
-- delete the record that a step sent one.
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_flow_version_id_fkey" FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- CONSTRAINTS
-- ===========================================================================

ALTER TABLE "flow_versions"
  ADD CONSTRAINT flow_versions_version_positive CHECK (version >= 1);

-- A draft has no publisher and a published version has one.
--
-- Without it a version can carry published_at with nobody named, which is the
-- shape of "the system published this by itself" - and the audit question a
-- tenant asks about an automated conversation is who turned it on.
ALTER TABLE "flow_versions"
  ADD CONSTRAINT flow_versions_published_has_publisher
  CHECK ((published_at IS NULL) = (published_by_user_id IS NULL));

-- The two halves of the partial-unique trick, and neither is optional.
--
-- The first is what makes the unique index MEAN "one live run per
-- conversation": without it a live run can carry NULL here and a second live
-- run for the same conversation slips straight past the index, which is the
-- exact failure the column exists to prevent, now invisible.
ALTER TABLE "flow_runs"
  ADD CONSTRAINT flow_runs_active_conversation_matches_status
  CHECK ((status IN ('ACTIVE', 'PAUSED')) = (active_conversation_id IS NOT NULL));

-- The second stops the duplicate drifting from the column it duplicates. A run
-- whose active_conversation_id named some OTHER conversation would hold that
-- conversation's slot while advancing this one.
ALTER TABLE "flow_runs"
  ADD CONSTRAINT flow_runs_active_conversation_is_its_own
  CHECK (active_conversation_id IS NULL OR active_conversation_id = conversation_id);

-- A live run knows where it is standing, and PAUSED is the load-bearing half.
--
-- A run whose window shut keeps its position - that is the whole difference
-- between pausing and failing, and it is what lets the entry template pick the
-- customer up where they left off rather than starting them again. A PAUSED row
-- with a NULL current_node_id has silently lost the thing pausing exists to
-- keep, and nothing downstream would report it: the resume would simply begin
-- from the top and the customer would answer the same three questions twice.
ALTER TABLE "flow_runs"
  ADD CONSTRAINT flow_runs_live_run_has_a_position
  CHECK ((status IN ('ACTIVE', 'PAUSED')) = (current_node_id IS NOT NULL));

-- An ended run says when, and a live one does not.
ALTER TABLE "flow_runs"
  ADD CONSTRAINT flow_runs_ended_when_finished
  CHECK ((status IN ('ACTIVE', 'PAUSED')) = (ended_at IS NULL));

ALTER TABLE "flow_runs"
  ADD CONSTRAINT flow_runs_step_count_non_negative CHECK (step_count >= 0);

ALTER TABLE "flow_run_steps"
  ADD CONSTRAINT flow_run_steps_seq_positive CHECK (seq >= 1);

-- The discriminated action gains its second arm.
--
-- Phase 6 wrote the first and said in as many words that a second action kind
-- gets its own arm here, and that the absence of one should be a migration
-- that fails rather than a binding that polls a sheet and does nothing with
-- what it finds. Replaced rather than added to, so there is one constraint
-- describing the whole column instead of two that could disagree.
ALTER TABLE "lead_sources" DROP CONSTRAINT lead_sources_action_has_its_target;

ALTER TABLE "lead_sources"
  ADD CONSTRAINT lead_sources_action_has_its_target
  CHECK (
    (action = 'TEMPLATE' AND template_id IS NOT NULL)
    OR (action = 'FLOW' AND flow_version_id IS NOT NULL)
  );

-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No GRANT statements for the ordinary CRUD: default privileges from
-- 20260814220000 already cover app_runtime and app_admin, and never TRUNCATE.

ALTER TABLE "flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flows" FORCE ROW LEVEL SECURITY;

CREATE POLICY flows_company_isolation ON "flows"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY flows_admin_access ON "flows"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "flow_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flow_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY flow_versions_company_isolation ON "flow_versions"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY flow_versions_admin_access ON "flow_versions"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "flow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flow_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY flow_runs_company_isolation ON "flow_runs"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY flow_runs_admin_access ON "flow_runs"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "flow_run_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flow_run_steps" FORCE ROW LEVEL SECURITY;

CREATE POLICY flow_run_steps_company_isolation ON "flow_run_steps"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY flow_run_steps_admin_access ON "flow_run_steps"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Append-only, enforced by a revoked grant rather than by convention
-- ---------------------------------------------------------------------------
--
-- flow_run_steps is the only record of what a customer was actually asked and
-- what they actually answered. The version they were asked FROM is immutable,
-- but the path they took through it is what a dispute is about - "your bot told
-- me it was in stock" - and a row that can be updated is a record that can be
-- tidied by the party the dispute is with.
--
-- kyc_documents is append-only by convention and says so in a comment. This one
-- is append-only because app_runtime cannot write it any other way, which is a
-- different and better guarantee: nothing depends on the next person to touch
-- the write path remembering.
--
-- A policy would not do this. RLS narrows which ROWS a role may touch within
-- the privileges a GRANT already gives it, so a policy cannot subtract UPDATE
-- from a role that holds it. Both halves are needed and this is the grant half.
REVOKE UPDATE, DELETE ON "flow_run_steps" FROM app_runtime;

-- app_admin deliberately keeps both.
--
-- The tenant-facing guarantee is that a business cannot edit its own record of
-- what it told a customer. The platform admin is a separate account space with
-- its own audit trail, and DPDP erasure is discharged through it - the same
-- argument that makes deleteCompanyKycDocuments exist at all. Revoking here
-- would leave an obligation with no path to satisfy it.
