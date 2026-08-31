-- A number Meta stopped returning is marked, never deleted.
--
-- The refresh job asks Meta for the numbers on a WhatsApp Business Account and
-- writes what comes back. The interesting case is what it does about a number
-- we hold that the answer does not mention.
--
-- Deleting it is the obvious thing and it is wrong. A number vanishing because
-- somebody removed it in Business Manager and a number vanishing because one
-- API call came back short are the same event from here - same absence, same
-- empty space in the list - and only one of them is real. Meta returns partial
-- pages, tokens lose scope, and an account can be temporarily unreadable
-- without any error the caller can see.
--
-- Delete on the wrong one and the row is gone along with every conversation
-- that referenced it, on evidence that amounts to a field not being present.
--
-- So absence is recorded as a fact about the last refresh rather than acted on:
--
--   missing_since    when Meta FIRST stopped returning it. Untouched by later
--                    refreshes that also miss it, so the age of the absence is
--                    readable - a number missing for two minutes and one
--                    missing for two weeks are different situations.
--   missing_reason   a machine code, never prose, in the shape skipped_reason
--                    already uses on whatsapp_media and the webhook events.
--
-- Both are cleared the moment Meta returns the number again, which is what
-- makes a transient absence self-correcting instead of a permanent mark.
--
-- What acts on it is a person: the numbers page shows the number as missing
-- with the date, and removing it stays a deliberate act by somebody who knows
-- whether they removed it from Meta.

-- No index on missing_since, deliberately. The query it would serve - "which of
-- this company's numbers are missing" - runs against a handful of rows per
-- tenant and is already covered by the composite index leading with company_id.
-- A partial index would be the right shape and cannot be expressed in
-- schema.prisma, so it would read as permanent drift on every check.

ALTER TABLE "whatsapp_numbers"
  ADD COLUMN "missing_since" TIMESTAMPTZ(3),
  ADD COLUMN "missing_reason" TEXT;
