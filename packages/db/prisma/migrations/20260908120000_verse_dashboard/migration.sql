-- Verse's share of the work, on the dashboard that already counts the flow's.
--
-- ===========================================================================
-- WHY A SECOND COLUMN AND NOT A WIDER DEFINITION OF THE FIRST
-- ===========================================================================
--
-- conversations_automated counts threads a FLOW stood in. The obvious move is
-- to widen it to "threads any automation stood in" and leave the card alone.
--
-- That would be wrong in a way nobody could see from the page. The two are
-- different capabilities with different failure modes and different things to
-- do about them: a flow that is not taking work needs its tree looking at, and
-- a Verse campaign that is not needs its knowledge base looking at. Collapsed
-- into one bar, a tenant whose flow is doing nothing and whose campaigns are
-- doing everything reads a healthy number and has no idea.
--
-- It would also silently change what a stored figure means. Every rollup
-- written before this migration counted flows only, and widening the column
-- makes yesterday's number and today's incomparable with nothing recording
-- that they are.

ALTER TABLE "dashboard_rollups"
  ADD COLUMN "conversations_verse" INTEGER NOT NULL DEFAULT 0;

-- A thread Verse handled is still a thread.
--
-- The same CHECK the flow count carries, and for the reason Phase 7 recorded:
-- a rate that cannot exceed 100% is worth a constraint rather than a comment.
-- One statement computes both counters, and a FILTER clause that overlaps or
-- misses would make the chart quietly not add up - this is the only thing that
-- would ever notice.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_verse_within_total
  CHECK (conversations_verse >= 0
         AND conversations_verse <= conversations_total);

-- Deliberately NOT asserted: automated + verse <= total.
--
-- They can legitimately overlap. A conversation a flow opened and handed over,
-- which a Verse campaign later picked up, is one thread counted by both - and
-- that is true rather than double-counted, because the card renders each as
-- its own proportion of all conversations rather than as slices of a pie.
--
-- Asserting a sum here would refuse a real and correct state, which is worse
-- than not asserting it: a constraint that fires on valid data gets dropped,
-- and the two that are genuinely load-bearing above would go with it.
