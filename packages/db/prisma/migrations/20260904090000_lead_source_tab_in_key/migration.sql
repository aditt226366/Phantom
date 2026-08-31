-- The tab belongs in the idempotency key.
--
-- ---------------------------------------------------------------------------
-- What 20260902090000 got wrong
-- ---------------------------------------------------------------------------
--
-- That migration keyed on (company_id, spreadsheet_id, row_hash) and argued
-- that two bindings on one spreadsheet are more likely a mistake than an
-- intent. That is true of two bindings on the same TAB and false of two
-- bindings on different tabs, which is an ordinary setup: a workbook with
-- "Website enquiries" and "Trade show" as separate sheets, each feeding a
-- different template.
--
-- Under the old key the second of those was permanently dead. Every row it
-- read collided with a hash the first binding had already claimed, it counted
-- duplicates for ever, and nothing it saw was ever contacted. Silent, and the
-- page's only account of it was a rising "already sent from this spreadsheet"
-- count that reads like a coincidence.
--
-- It also collapsed two genuinely different leads: the same name and number
-- typed into two tabs hash identically, because the hash covers the mapped
-- cells and nothing else. One of them was never messaged.
--
-- ---------------------------------------------------------------------------
-- What this changes, and what it deliberately does not
-- ---------------------------------------------------------------------------
--
-- The key becomes (company_id, spreadsheet_id, tab, row_hash). Two bindings on
-- the SAME tab still collide, which is the case that was worth protecting -
-- that really is one list read twice, and the customer would hear from the
-- business twice for one enquiry.
--
-- The tab goes in the INDEX rather than into rowHash. Two reasons, and the
-- second is the one that matters:
--
--   1. rowHash is the answer to "has this person already been sent this
--      message", and it is stored in customers' message history by way of the
--      sends it authorises. Changing what it covers re-hashes every row of
--      every bound sheet and makes all of them look new - a message to every
--      customer a tenant has ever imported, with no undo. The version prefix
--      exists to make that visible, not to make it cheap.
--   2. A column can be added to an index; a hash input cannot be added to
--      hashes already written.
--
-- The cost, stated because it is a real change of behaviour: a row MOVED
-- between tabs of one spreadsheet is now a new lead and will be contacted
-- again. 20260902090000 argued the opposite. Moving a row between tabs is a
-- deliberate act on a list somebody is curating, and treating two tabs as two
-- lists is what makes the common setup work at all - so the trade is accepted
-- here rather than left as a surprise.

-- ===========================================================================
-- THE COLUMN
-- ===========================================================================
--
-- Added nullable, backfilled from the binding, then made NOT NULL. The
-- alternative - NOT NULL with no default - is right only when the table must be
-- empty, and this one has a correct value available for every existing row.
--
-- The FORCE dance is required and is not optional politeness. FORCE ROW LEVEL
-- SECURITY subjects the owner to policies scoped TO app_runtime, so a bare
-- UPDATE here matches no policy, touches zero rows, reports success, and the
-- migration carries on leaving every row NULL - which the SET NOT NULL below
-- would then fail on, at the least useful moment. Drop FORCE, never the policy:
-- everyone else stays constrained throughout the window.
-- See packages/db/tests/force-rls-backfill.test.ts for the worked example.

ALTER TABLE "lead_source_rows" ADD COLUMN "tab" TEXT;

ALTER TABLE "lead_source_rows" NO FORCE ROW LEVEL SECURITY;

UPDATE "lead_source_rows" r
   SET "tab" = l."tab"
  FROM "lead_sources" l
 WHERE l."id" = r."lead_source_id"
   AND r."tab" IS NULL;

ALTER TABLE "lead_source_rows" FORCE ROW LEVEL SECURITY;

-- Any row whose binding has since been deleted would still be NULL here, and
-- there cannot be one: lead_source_rows.lead_source_id is ON DELETE CASCADE, so
-- a row without a binding does not exist. If this ever fails, that FK changed.
ALTER TABLE "lead_source_rows" ALTER COLUMN "tab" SET NOT NULL;

-- ===========================================================================
-- THE KEY
-- ===========================================================================
--
-- Dropped and recreated rather than added alongside. Leaving the old index in
-- place would keep enforcing the narrower rule, so the second binding would
-- stay dead and the new index would be decoration.

DROP INDEX "lead_source_rows_company_id_spreadsheet_id_row_hash_key";

CREATE UNIQUE INDEX "lead_source_rows_company_id_spreadsheet_id_tab_row_hash_key"
  ON "lead_source_rows"("company_id", "spreadsheet_id", "tab", "row_hash");
