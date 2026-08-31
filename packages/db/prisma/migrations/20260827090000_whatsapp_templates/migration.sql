-- Message templates, and an append-only record of every edit.
--
-- ---------------------------------------------------------------------------
-- components is jsonb, and it is the submission rather than a rendering of it
-- ---------------------------------------------------------------------------
--
-- Decision 10: the Studio's preview and the Graph POST read the same value, so
-- what a tenant approved on screen cannot drift from what Meta received. A
-- normalised header/body/footer/buttons split would mean two assemblies of one
-- thing, and the day they disagree is the day a customer gets a message nobody
-- reviewed. It is also Meta's schema and not ours, so a column per field would
-- need a migration every time they extend the vocabulary.
--
-- status and category are TEXT for the reason 20260816100000 gives about number
-- status, plus one sharper: Meta re-categorises templates whose wording it
-- reads as promotional, so `category` can change to a value the tenant never
-- chose - and the price changes with it. A write that rejected an unfamiliar
-- value would drop exactly that news.
--
-- ---------------------------------------------------------------------------
-- The edit quota is derived from whatsapp_template_edits, and is a FLOOR (R8)
-- ---------------------------------------------------------------------------
--
-- No counter column, deliberately: a counter is a second source of truth for
-- something the rows already say, and it is wrong the first time a write
-- half-fails. Counting is cheap here - a template is edited a handful of times
-- a month - and the index makes the window a seek.
--
-- What the count produces is a floor rather than the quota, because Meta counts
-- edits made in Business Manager and those never reach this table. The Studio
-- labels it "edits made here"; the Edit button is never the enforcement.

CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "meta_template_id" TEXT,
    "rejected_reason" TEXT,
    "status_updated_at" TIMESTAMPTZ(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_template_edits" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "edited_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_template_edits_pkey" PRIMARY KEY ("id")
);

-- Meta's own uniqueness rule, scoped per company so it is a tenant fact rather
-- than a global one: two companies must never collide, and neither must learn
-- of the other by failing to insert.
CREATE UNIQUE INDEX "whatsapp_templates_company_id_name_language_key"
  ON "whatsapp_templates"("company_id", "name", "language");

CREATE INDEX "whatsapp_templates_company_id_updated_at_idx"
  ON "whatsapp_templates"("company_id", "updated_at" DESC);

CREATE INDEX "whatsapp_templates_company_id_status_idx"
  ON "whatsapp_templates"("company_id", "status");

-- The quota read: "edits to this template since T".
CREATE INDEX "whatsapp_template_edits_company_id_template_id_created_at_idx"
  ON "whatsapp_template_edits"("company_id", "template_id", "created_at" DESC);

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "integrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, like every other authorship column here: deleting an employee must
-- not delete the template their colleagues are still sending.
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_template_edits"
  ADD CONSTRAINT "whatsapp_template_edits_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_template_edits"
  ADD CONSTRAINT "whatsapp_template_edits_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_template_edits"
  ADD CONSTRAINT "whatsapp_template_edits_edited_by_user_id_fkey"
  FOREIGN KEY ("edited_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- No GRANT statements: default privileges from 20260814220000 already cover
-- app_runtime and app_admin CRUD, and never TRUNCATE.

ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_templates" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_templates_company_isolation ON "whatsapp_templates"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_templates_admin_access ON "whatsapp_templates"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "whatsapp_template_edits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_template_edits" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_template_edits_company_isolation ON "whatsapp_template_edits"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY whatsapp_template_edits_admin_access ON "whatsapp_template_edits"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);
