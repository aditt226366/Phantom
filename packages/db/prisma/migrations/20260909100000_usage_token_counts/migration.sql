-- ===========================================================================
-- TOKEN COUNTS ON usage_events
-- ===========================================================================
--
-- Two nullable columns, and the reason is the reason the table exists.
--
-- usage_events records the facts we own - a call happened, against this
-- company, at this moment - because platform-level provider keys are only safe
-- to expose to per-tenant traffic if every call is attributed. Pricing is
-- Phase 11, and every row carries a price_version precisely so it can be
-- repriced in arrears.
--
-- Repriced from WHAT, though. Per-call pricing can be reconstructed from the
-- rows we already have; per-TOKEN pricing cannot, and per-token is how every
-- model provider bills. A row written today without its token counts is a row
-- that can never be priced correctly, by any later work, because the number is
-- not recoverable from anywhere - the provider's response is long gone and
-- nothing else recorded it.
--
-- So: two columns now, or a permanent hole in the record.
--
-- ---------------------------------------------------------------------------
-- NULLABLE, and never backfilled to zero
-- ---------------------------------------------------------------------------
--
-- Existing rows genuinely have no token counts. Every non-model kind
-- (whatsapp.message.sent, integration.verify, whatsapp.numbers.refresh) never
-- will, because a Graph call has no tokens at all.
--
-- Zero would be a lie of exactly the kind cost_micros already refuses: it
-- claims a call consumed nothing, sums as though it were measured, and is
-- indistinguishable from a real zero once it is in the table. NULL is the
-- absence of a claim, SUM ignores it, and "how many replies do we have token
-- counts for" stays an answerable question - which is the one a Phase 11
-- repricing has to ask first.
--
-- ---------------------------------------------------------------------------
-- THE CACHE SPLIT, which will need a third and fourth column
-- ---------------------------------------------------------------------------
--
-- Measured against the live Anthropic API in Phase 9 (see
-- apps/web/scripts/verse-probe.mjs, which printed it):
--
--   {"input_tokens":414,
--    "cache_creation_input_tokens":0,
--    "cache_read_input_tokens":0,
--    "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},
--    "output_tokens":49,
--    "service_tier":"standard",
--    "inference_geo":"global"}
--
-- `cache_creation_input_tokens` and `cache_read_input_tokens` are NOT included
-- in `input_tokens`. They are a separate split of the billable input, priced
-- differently - creation above the base rate, reads far below it.
--
-- Nothing in this system enables prompt caching, so both are zero today and
-- `input_tokens` is the whole input bill. The moment anything turns caching on
-- - and the system prompt carrying a knowledge base is exactly what caching is
-- for - `input_tokens` stops being that, and a bill computed from these two
-- columns alone silently undercounts. Every recorded-response test stays green,
-- because the fixtures were recorded before it.
--
-- That is written here rather than built, because a column for a feature
-- nothing uses is a column nothing writes, and this repository has a rule about
-- those. What it costs to record the shape now is nothing; what it buys is that
-- the extension is expected rather than discovered.
--
-- The extension, when it comes: cache_creation_input_tokens and
-- cache_read_input_tokens as two more nullable columns, and the same rule about
-- zero - a row from before caching has NULL, not 0, because it did not measure
-- them rather than measuring them as none.

ALTER TABLE "usage_events" ADD COLUMN "input_tokens"  INTEGER;
ALTER TABLE "usage_events" ADD COLUMN "output_tokens" INTEGER;

-- Not a check that they are non-negative and not much else, deliberately: this
-- column holds what the provider said, and a guess about what the provider may
-- say is how a correct response gets rejected. Non-negative is safe though - a
-- negative token count is not a number any provider means.
ALTER TABLE "usage_events"
  ADD CONSTRAINT "usage_events_token_counts_are_not_negative"
  CHECK (
    ("input_tokens"  IS NULL OR "input_tokens"  >= 0)
    AND
    ("output_tokens" IS NULL OR "output_tokens" >= 0)
  );

-- No GRANT statements: default privileges from 20260814220000 cover
-- app_runtime and app_admin, and a column added to an existing table inherits
-- the table's grants rather than needing its own.
