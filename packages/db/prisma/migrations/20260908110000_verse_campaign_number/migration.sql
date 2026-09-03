-- Which number a campaign sends from.
--
-- ===========================================================================
-- WHY IT IS NOT DERIVED FROM THE TEMPLATE
-- ===========================================================================
--
-- A template belongs to an integration, and an integration can hold several
-- WhatsApp numbers. So "the template's number" is not a thing: it would be a
-- pick among several, made silently, and a business running one number for
-- support and another for marketing would find a campaign going out from
-- whichever row happened to sort first.
--
-- Naming it on the campaign makes it a choice the tenant made in the wizard,
-- visible on the campaign page, and stable if a number is added later.
--
-- ===========================================================================
-- WHY THIS IS A THIRD MIGRATION
-- ===========================================================================
--
-- Found while writing the engine, after 20260908090000 had been applied. The
-- conventions are explicit that an in-place amendment forks the checksum of
-- every database that ran the original, and that the remedy - rebuild them all
-- - is available here and would not be in production. Additive is the shape
-- that would be required if this were deployed, so it is the shape used.

ALTER TABLE "verse_campaigns" ADD COLUMN "whatsapp_number_id" TEXT;

ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT "verse_campaigns_whatsapp_number_id_fkey"
  FOREIGN KEY ("whatsapp_number_id") REFERENCES "whatsapp_numbers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not SET NULL. A campaign whose number has been deleted cannot send
-- and must not silently become a campaign that sends from nowhere - the delete
-- is refused instead, which puts the decision in front of the person making it.

-- Nullable, and deliberately so: a DRAFT campaign is built up field by field in
-- the wizard and does not have a number until the tenant picks one. What makes
-- a RUNNING campaign without a number impossible is the CHECK below rather than
-- NOT NULL, because NOT NULL would refuse the insert that creates the draft.
ALTER TABLE "verse_campaigns"
  ADD CONSTRAINT verse_campaigns_running_has_a_number
  CHECK (
    "status" IN ('DRAFT', 'ARCHIVED')
    OR "whatsapp_number_id" IS NOT NULL
  );

CREATE INDEX "verse_campaigns_company_id_whatsapp_number_id_idx"
  ON "verse_campaigns"("company_id", "whatsapp_number_id");
