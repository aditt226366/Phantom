-- Two figures the flow builder makes real, and one card that stops lying.
--
-- ===========================================================================
-- WHY THIS IS A MIGRATION IN THIS PHASE AND NOT A LATER TIDY-UP
-- ===========================================================================
--
-- Phase 7 shipped four honest empty states in apps/web/lib/dashboard/pending.ts
-- and wrote the obligation into spec-amendments.md in as many words: the phase
-- that lands one of those capabilities replaces its card, and a phase that
-- ships the capability while leaving the card saying "arrives with" is one
-- whose own dashboard denies it exists.
--
-- This phase lands two of them.
--
--   lead_score          an action node sets it, so "Lead temperature" is a
--                       real distribution rather than a promise
--   automated handling  a flow answers customers, so "Nothing here is
--                       automated yet" is now false on a page whose every
--                       other figure is true
--
-- The second is the sharper one. That sentence was correct when it was
-- written and becomes a false statement about the tenant's own business the
-- moment a flow is published - which is exactly the failure mode the pending
-- cards exist to prevent, arriving from the other direction.

ALTER TABLE "dashboard_rollups"
  -- Contacts by lead temperature, as {"HOT": 12, "WARM": 30, "COLD": 4}.
  --
  -- jsonb rather than three columns, and deliberately unlike the delivery
  -- ladder beside it. The ladder is presented as a partition of everything
  -- sent, so it is asserted by a CHECK and a column per member costs nothing.
  -- This is read as a distribution and rendered by iterating it.
  --
  -- Contacts with NO score are absent rather than counted under a fourth key.
  -- Unscored is not COLD: a business whose whole contact book has never been
  -- through a flow would otherwise read as a business whose customers are all
  -- uninterested, which is the same class of false number the pending card
  -- existed to avoid.
  ADD COLUMN "contacts_by_score" JSONB NOT NULL DEFAULT '{}',

  -- Conversations a flow has handled at least one step of.
  --
  -- Counted from flow_runs rather than inferred from conversations, and the
  -- difference matters. The obvious proxy - a thread with no assigned user -
  -- is what Phase 7 refused to use for the AI card, because it would have
  -- counted every untouched thread as an automation success. This counts
  -- threads a run actually stood in.
  ADD COLUMN "conversations_automated" INTEGER NOT NULL DEFAULT 0;

-- A thread a flow handled is still a thread.
--
-- The card renders automated as a proportion of all conversations, so a count
-- above the total draws a bar off the end of its track - which looks like a
-- CSS bug and gets chased in the wrong file. The same argument as
-- dashboard_rollups_replied_within_messaged, one column over.
ALTER TABLE "dashboard_rollups"
  ADD CONSTRAINT dashboard_rollups_automated_within_total
  CHECK (conversations_automated >= 0
         AND conversations_automated <= conversations_total);
