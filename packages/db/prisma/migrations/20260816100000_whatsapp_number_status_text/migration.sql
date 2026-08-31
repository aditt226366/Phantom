-- whatsapp_numbers.status becomes text, and the enum type goes with it.
--
-- The test is who defines the vocabulary, and 20260815130000 wrote it down:
-- ours can be an enum, because adding a member is our decision and arrives with
-- a migration; Meta's cannot, because adding one is their decision and arrives
-- without warning. This column is Meta's and was modelled as ours.
--
-- Meta documents more members than we modelled. Beyond CONNECTED, PENDING,
-- FLAGGED and RESTRICTED there are at least BANNED, MIGRATED, RATE_LIMITED and
-- UNVERIFIED, and that list has changed before.
--
-- ---------------------------------------------------------------------------
-- Why this is not the crash hazard message.type was, and still wrong
-- ---------------------------------------------------------------------------
--
-- message.type as an enum would have failed the INSERT on an inbound webhook -
-- the worst place in the system to fail, because nobody is watching and the
-- customer's message is lost. This column is safer: the UNKNOWN member absorbs
-- a value we do not recognise and the write succeeds.
--
-- It succeeds by discarding the answer. A number Meta has BANNED is stored as
-- UNKNOWN, and the operator reading the page is told we do not know rather than
-- being told the one thing they need to act on. That is exactly the reasoning
-- that made messaging_tier and throughput_level text in the same table - an
-- unrecognised tier must render as itself at 3am rather than reject the refresh
-- that carried it - and this column was left behind.
--
-- quality_rating stays an enum, deliberately. GREEN/YELLOW/RED/UNKNOWN is a
-- genuinely closed traffic light: it is a rating scale, not a state machine
-- Meta keeps adding states to.
--
-- ---------------------------------------------------------------------------
-- A type swap, not a data migration, and that is the reason for the timing
-- ---------------------------------------------------------------------------
--
-- The table is effectively empty: nothing writes status yet. The numbers
-- refresh job is the first code that will, and doing this afterwards would mean
-- changing the column, the job that writes it and the page that reads it in
-- three separate commits with a live consumer in between.
--
-- USING "status"::text is exact - an enum's text representation is its label -
-- so no value can change meaning here.
--
-- UNKNOWN survives as the default and as a value. It is still what "Meta has
-- told us nothing" means, and sendPolicy still refuses to send from it; what
-- changes is that a status we do not recognise is now stored verbatim and
-- treated as UNKNOWN for the send decision, rather than being flattened into it
-- on the way in.

ALTER TABLE "whatsapp_numbers" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "whatsapp_numbers"
  ALTER COLUMN "status" TYPE TEXT USING "status"::text;

ALTER TABLE "whatsapp_numbers" ALTER COLUMN "status" SET DEFAULT 'UNKNOWN';

-- Nothing else references the type. Left behind it would be an empty shape in
-- the catalog that the next reader has to work out is dead.
DROP TYPE "whatsapp_number_status";
