-- "A person is needed here" becomes a state, because it now has three writers.
--
-- ===========================================================================
-- WHY A DERIVED SIGNAL STOPPED WORKING
-- ===========================================================================
--
-- Phase 5 derived it: `assigned_user_id IS NULL AND unread_count > 0`. That
-- was right at the time and its own comment said why - there was exactly one
-- way a thread came to need somebody, which was a customer writing in and
-- nobody having read it yet. A derivation over two columns that already
-- existed beat a column nothing would have kept honest.
--
-- The flow builder made that false in a way the derivation cannot express. A
-- handoff node is a PROACTIVE claim: the automation has decided it cannot
-- finish, and that is true whether or not anybody has read the thread and
-- whether or not the customer is waiting on a reply. There are three writers
-- now - an unread inbound, a handoff node, an action node's notify - and the
-- next one is already named, which is Verse's escalation.
--
-- ===========================================================================
-- THE BUG THIS FIXES, WHICH WAS NOT THEORETICAL
-- ===========================================================================
--
-- The handoff shipped by faking the derivation's inputs: it incremented
-- unread_count so that `unread > 0` would hold. Two things are wrong with
-- that, and the second is the one that bites.
--
-- It lies. unread_count means "inbound messages nobody here has read", and
-- there is no such message - the flow decided this by itself.
--
-- And markConversationRead decrements it. Opening the thread to see WHY a
-- person was wanted is what destroys the only record that one was: the count
-- goes to zero, the thread leaves waiting-for-a-human with nobody assigned and
-- nothing resolved, and it is now invisible in exactly the queue it was put
-- into. A signal that a glance erases is not a signal.
--
-- So the state is explicit and nothing derives it. It is set by whoever
-- decides a person is needed and cleared by somebody taking the thread, and
-- reading it is not the same act as clearing it.

ALTER TABLE "conversations"
  -- When the thread was flagged, and NULL for the overwhelming majority.
  --
  -- A nullable timestamp rather than a boolean, for the reason every other
  -- state column in this schema is one: "since when" is the question a queue
  -- sorted oldest-first has to answer, and a boolean would need a second
  -- column beside it to answer it. It is also what makes the flag idempotent
  -- to set - see flagNeedsHuman, which does not move an instant that is
  -- already there.
  ADD COLUMN "needs_human_at" TIMESTAMPTZ(3),

  -- Why, in words somebody reading the queue can act on.
  --
  -- Stored rather than derived from the flow run, because the reasons do not
  -- share a source: a handoff node's note is the author's, an action node's
  -- notify carries its own, and an escalation later will carry a third. A
  -- reader joining flow_runs to find out would get nothing for the one that
  -- did not come from a flow.
  ADD COLUMN "needs_human_reason" TEXT;

-- The queue, and the dashboard card above it.
--
-- Deliberately NOT partial, although `WHERE needs_human_at IS NOT NULL` is the
-- only shape anything reads this column in and the flagged rows are a small
-- minority of a table that grows with every conversation the business has ever
-- had.
--
-- schema.prisma cannot express a partial index, so a hand-written one is
-- permanent drift on every `prisma migrate diff` - and a drift check that is
-- always red is one people stop reading, which costs more than the index pages
-- save. The same trade this schema already made for flow_runs, where the
-- workaround was a nullable duplicate column; here there is nothing to
-- duplicate and no uniqueness to enforce, so the plain index simply wins.
CREATE INDEX "conversations_company_id_needs_human_at_idx"
  ON "conversations" ("company_id", "needs_human_at");

-- The two columns answer together or not at all.
--
-- A flagged thread with no reason renders as a blank cell in the queue
-- somebody is reading to decide what to pick up, and a reason sitting on a
-- thread nothing flagged is a sentence that will be shown the next time it IS
-- flagged, for a reason that has nothing to do with why.
ALTER TABLE "conversations"
  ADD CONSTRAINT conversations_needs_human_has_a_reason
  CHECK ((needs_human_at IS NULL) = (needs_human_reason IS NULL));
