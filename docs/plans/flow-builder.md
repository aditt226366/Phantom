# The rule-based flow builder

Working plan, written as the phase ran. Status: **complete, tagged
`flow-builder-runtime` and `flow-builder`.**

Amendment A1. A tenant draws a decision tree; a customer taps buttons and the
flow advances. No model is involved at any point, so the same input always
produces the same next node — which is the product being sold, and also what
makes it answerable to Meta's January 2026 ban on general-purpose chatbots
without an argument.

---

## Why the tags are named rather than numbered

Phase 7 is already conversation pricing (`phase-5.md` says so), Phase 9 is the
dashboard, and `spec-amendments.md` is explicit that the numbers need **one
deliberate renumbering pass** rather than an edit per amendment — three phases
changed size and two changed position. Claiming a number here would be the
thing that document asks nobody to do, so the tags are `flow-builder-runtime`
and `flow-builder`.

The split is at the line between the runtime and the builder UI, which is also
where `.githooks/SKIP_VISUAL` lived: nothing below that line renders a page.

---

## The two things that could not be retrofitted

Everything else in this phase is a normal feature. These two are decided once
and are then unreachable.

### A button id sits in a customer's chat history for ever

WhatsApp buttons never expire. A customer scrolls up three days, taps "Yes" on
a message from a flow that finished on Tuesday, and what arrives is the string
we wrote — unchanged, unrewritable, and with no way to ask Meta what it used to
mean.

So an id meaning "yes" is ambiguous **by construction**. It cannot say which
question it answered or which run it belonged to, and a runtime receiving one
has to guess. The guess it would make is the dangerous one: advance whatever
run the conversation currently has, from wherever it currently is.

```
f1.r.<runId>.<nodeId>.<choice>     a reply inside a running flow
f1.e.<versionId>.<nodeId>          an entry point, before any run exists
```

`f1` is a scheme tag and is checked first, because the second scheme cannot be
a *change* to the first — it has to be a new prefix that the old decoder
rejects. That is the only migration available for a value we cannot reach.

Two kinds, because the entry genuinely has no run. A tap on an approved
template's quick reply is what *creates* one, and creating a run per recipient
of a ten-thousand-person broadcast — most of whom never tap — is not something
to do eagerly. Naming the version is also what makes "that version was
unpublished since" a recognisable outcome rather than a run beginning on a
draft somebody is halfway through editing.

Parsing is total and never throws, and `not_ours` is separate from `malformed`.
A customer with two vendors in their WhatsApp taps somebody else's button and
it lands in our webhook; recording that as an error would turn a flow's decline
count into a count of other people's buttons. An inbound webhook is also the
worst place in the system to throw — nobody is watching, the delivery retries,
and the customer's message is lost.

### A run whose window shuts pauses, with its position kept

The ordinary case, not an error: the customer stopped replying for a day and
the 24-hour window closed with them halfway down the tree. Nothing has gone
wrong; the flow simply cannot speak until spoken to.

Failing it would discard their answers and show an operator an error for
something that is merely waiting. So the run is `PAUSED`, `current_node_id` is
kept, and the entry template can pick them up exactly where they stopped.

Enforced by a CHECK rather than by care:

```sql
CHECK ((status IN ('ACTIVE', 'PAUSED')) = (current_node_id IS NOT NULL))
```

A `PAUSED` row with a null position has lost the only thing pausing exists to
keep, and **nothing downstream would report it** — the resume would simply
begin from the top and the customer would answer the same three questions
twice.

The window is checked in two places and they are not redundant. The executor
checks before emitting sends, which is the difference between pausing and
queueing four messages Meta refuses one at a time. The send path checks
immediately before the Graph call, which is the boundary — the window can close
between a step being planned and the queue reaching it — and when it declines a
flow message for `window_closed` it pauses the run, or the run sits `ACTIVE`
for ever beside a thread of POLICY failures.

---

## The model

| Table | Holds |
| --- | --- |
| `flows` | a name, and a pointer at the version that is live |
| `flow_versions` | the trees, as jsonb |
| `flow_runs` | one customer's position, pinned to a version |
| `flow_run_steps` | what happened, one row at a time, for ever |

### Why a run pins a version

A customer is three questions deep. The tenant opens the builder, deletes the
branch that customer is standing on, and publishes. If a run read the flow's
*current* graph, the next tap would name a node that no longer exists and the
only honest thing to do with it would be nothing.

Pinning means every run in flight finishes on the tree it began on. The cost —
a fix to a live flow does not reach the customers currently inside it — is the
right way round: they are mid-conversation, and changing the questions
underneath somebody mid-conversation is worse.

The pin is one join. `loadRun` reads the graph through `flow_runs.flow_version_id`
and never through the flow's published version, and break-once confirmed it:
swapping that read for the published graph fails the assertion that a run
finishes on the tree it started on.

### A redundant column, for a guarantee with no other form

A conversation must never be in two flows at once — two runs would both send,
both wait, and the customer would receive two questions and be able to answer
one. But a conversation may hold any number of **finished** runs, because a
customer coming back next month is ordinary.

That is a partial unique index, which `schema.prisma` cannot express, and a
hand-written one shows as permanent drift on every `migrate diff` — a check
people learn to ignore. So `active_conversation_id` duplicates
`conversation_id` while the run is live and is NULL once it is not, and an
ordinary unique index does the work. The same NULL-distinct property that lets
`messages.wamid` be unique while many pending sends carry none.

Two CHECKs keep it honest, and the first is the one that makes the index *mean*
anything: a live run carrying NULL there would slip a second live run straight
past the unique — the exact failure the column exists to prevent, now
invisible. Break-once: dropped, the assertion fails; restored by `db:nuke`,
because the migration is the only copy of that DDL worth trusting.

### The step log only appends

`flow_run_steps` is the only record of what a customer was actually asked and
what they actually answered. The version they were asked *from* is immutable,
but the path they took through it is what a dispute is about — "your bot told
me it was in stock" — and a row that can be updated is a record that can be
tidied by the party the dispute is with.

`app_runtime` holds neither UPDATE nor DELETE on it. A policy could not do
this: RLS narrows which *rows* a role may touch within the privileges a GRANT
already gives it, so it cannot subtract UPDATE from a role that holds it.
`kyc_documents` is append-only by convention; this one is append-only because
the database refuses.

The waiver is `APPEND_ONLY_TABLES` in `schema-invariants.test.ts`, and it
**inverts** the CRUD assertion rather than skipping it — so a later migration
handing UPDATE back is a failing security test rather than a quiet return to
editable history. `app_admin` keeps both, because DPDP erasure is discharged
through the audited admin space.

---

## The engine is pure, and that is what made it testable

`planAdvance` decides; `packages/db/src/flows.ts` executes. The split lets the
ceiling, the routing and the determinism be asserted as values rather than
provoked through a fixture — and it puts the part that can fail apart from the
part that has to be predictable.

Cycles are **legal**. "Back to the main menu" is an ordinary thing to draw.
What is unsafe is a cycle with no customer input in it — message, action,
message, back to the first — and two different things stop it:

- `validateFlow` refuses a loop containing no waiting node, at publish, where
  the cost is a sentence rather than a thread full of messages nobody asked
  for;
- `MAX_STEPS_PER_ADVANCE` is the guard of last resort for a graph shape that
  check did not anticipate.

A run that hits the ceiling is `FAILED`, never `PAUSED`. Paused means "waiting
for the customer", and nothing there is waiting for anybody — an operator
seeing a paused run would wait for a tap that is never coming.

### The break-once that was not observed, and why the test was wrong

Multiplying `MAX_STEPS_PER_ADVANCE` by a million left the suite green.

The break was not unobservable; the test was weak. A runaway loop is refused by
*any* finite ceiling, so asserting "it stops" proves only termination — and
what it costs to be wrong is not an infinite loop, it is an effects array with
a million entries in it before anything gives up.

The assertion now brackets the number from both sides: a chain one node longer
than the ceiling is refused, and one exactly at it completes. The re-run break
fails.

---

## Five ways a tap is refused

Every one is recorded as a `DECLINED` step. "The bot ignored me" is
unanswerable without that; with it, the thread's own history says a tap arrived
for a node the run had already left, and when.

| Reason | The situation |
| --- | --- |
| `not_ours` | somebody else's button. Not an error |
| `run_ended` | the commonest stale tap — the flow finished on Tuesday |
| `stale_node` | the run is live and standing somewhere else |
| `version_unpublished` | the template went out last month; two publishes since |
| `run_already_active` | an entry tap while a question is already in front of them |

`stale_node` is the one the whole encoding exists for, and break-once on it
fails the assertion that a decline sends nothing.

A customer who **types** where a tap was wanted is handed to a person. "yes"
reads as agreement to a person and is not one to a tree; matching the label to
guess which button they meant is the cleverness that puts somebody in the wrong
branch — here, the branch that scores them HOT.

---

## What did not change

An interactive message is a new message **type** on the existing send path, not
a third send path. `messages.interactive_payload` sits beside
`template_payload`, the send worker branches on which is populated exactly as
it already branched, and the status ladder, the delivery callbacks, the retry,
the thread and the usage row needed no change at all.

A flow is the **third producer** of messages, after bulk and lead sources. Its
entry node is a caller of `materialiseOutboundTemplate` with `buttonPayloads`
set; its later steps go through `materialiseFlowMessage`, which shares the two
halves that matter — the last opt-out filter and the `advanceConversation` call
whose absence Phase 5 shipped and a screenshot caught.

`lead_sources.action` gained the second member Phase 6 built the discriminated
column for. A cold lead has no open window, so a FLOW binding contacts a row in
exactly the way a TEMPLATE binding does — one approved template, same
idempotency index — and what differs is the payloads on its buttons. The diff
in the poll handler is a target chosen before the loop and one line inside it.
Everything above that line is untouched, which is the proof the shape was
right.

---

## Two things the screenshots caught

Both are the reason the suite exists.

**The paused thread said nothing.** The picture was a closed window, a disabled
composer and a template picker — which reads as an ordinary lapsed
conversation. What is actually true is that a customer is halfway down a tree
and sending the flow's opening template puts them back exactly where they
stopped. The thread now says so and names the template.

**That banner then promised something false.** It said replying yourself stops
the flow, which was not true. It is now: sending into a thread with a live run
hands the run off. Two writers on one conversation is a real failure — the
operator answers, the customer taps the button still sitting above it, and the
flow asks its next question over the top of a conversation a person is now
having. Neither side knows about the other and only the customer can see both.

A third, smaller: the runs list said "Standing on n4". Correct, and meaningless
to the person reading it. It shows the step's own words now, resolved through
the run's **own** pinned version — because a run standing on a node a later
version deleted still has to say where it is.

---

## The dashboard obligation, discharged

Phase 9 wrote it down: the phase that lands one of the pending capabilities
replaces its card.

**Lead temperature** is a real distribution now. Unscored contacts are absent
from the map rather than counted as a fourth bucket — unscored means no flow
has ever asked them anything, and reporting it as COLD would tell a business
its entire contact book was uninterested.

**"Who is handling chats"** is the one that could not wait. Its copy said
"Nothing here is automated yet, so every reply so far was written by your
team." True when written, and a false statement about the tenant's own business
the moment a flow is published — on a page whose every other figure is true. A
pending card is not a placeholder that can be left; it is a claim, and claims
expire.

It counts conversations a flow actually stood in, `DISTINCT` on the
conversation. Never the absent-assignee proxy Phase 9 already refused, and
never a count of runs — a customer who returns has two runs in one thread,
which would report more automated conversations than the tenant has
conversations. A CHECK refuses that outright.

The two cards this phase does **not** cover had their copy checked, which was
worth doing: "From first contact to order" claimed to arrive with AI Messaging,
when what it actually waits on is order tracking. Naming a section that cannot
deliver it is a promise made by a dashboard.

---

## The builder is a list, not a canvas

A canvas is a dependency, an interaction model and a mobile problem, for a v1
whose whole job is to express a tree. This design system has no canvas
primitives — no node, no edge, no viewport, no pan — so one would mean
importing a library with its own visual language and fighting it back onto
`--wa-*` tokens.

A tree is also a thing a list expresses honestly. Every node names where each
branch goes, by the name of the node it goes to, in a select that cannot point
at a node that does not exist. What a canvas adds is spatial memory, which
matters at fifty nodes and not at eight — and eight is what three reply buttons
per question produces.

`validateFlow` runs on every keystroke, which is what the client-safe
`@whatsapp-os/core/flows` barrel is for: a fourth reply button is not a
warning, it is a message Meta will refuse, and an author should learn that when
they add it. The same function runs again on the server over the bytes that
arrived. That is the boundary; the first is feedback.

---

## The handoff signal, which shipped derived and should not have been

A handoff node originally "raised the thread" by incrementing `unread_count`,
so that Phase 5's derivation — `assigned_user_id IS NULL AND unread_count > 0`
— would hold. That was wrong twice.

It lies. `unread_count` means inbound messages nobody here has read, and a flow
deciding by itself that a person is needed produces no such message.

And `markConversationRead` decrements it. **Opening the thread to see why a
person was wanted is what destroyed the record that one was**: the count went
to zero, the thread left waiting-for-a-human with nobody assigned and nothing
resolved, and it was then invisible in exactly the queue it had been put into.
A signal a glance erases is not a signal.

`conversations.needs_human_at` is explicit and nothing derives it. A nullable
timestamp rather than a boolean, because "since when" is what a queue sorted
oldest-first has to answer. `flagNeedsHuman` COALESCEs, so re-flagging does not
move it — a customer who taps through into a second handoff has been waiting
since the first. The reason IS updated, because the newest sentence is the most
useful one. A CHECK keeps the two columns agreeing.

`notify` had the identical defect and shares the fix, without ending the run.

`handOff` takes `flagIfUnattended`, because its two callers mean opposite
things: a flow that could not understand a typed reply wants somebody, and an
operator who has just replied IS somebody. The previous version incremented
unread unconditionally, so replying to a customer raised the operator's own
badge.

### Three readers, and none of them was tested

| Site | What it is |
| --- | --- |
| `waitingForAHuman` | the dashboard card and its count |
| `needsHuman()` | the inbox row badge — the same derivation, in the web layer |
| `inboxWhere()` | the default view |

Each reads the flag **alongside** what it already checked, never instead: the
derivation describes a different thing that is still true, and replacing it
would have stopped showing every ordinary unread thread.

`waitingForAHuman` had no test at all, which is part of how the handoff shipped
satisfying neither clause — nothing asserted what the queue should contain, so
nothing noticed a new writer producing threads it could not see. It has five
now, including that the count and the list read one predicate.

### A handoff needs somewhere to go

`conversations.assigned_user_id` had been in the schema since Phase 1 and
**nothing ever wrote it**. Every read treated null as "nobody has picked this
up", which was true by construction because there was no way to pick anything
up.

That was survivable while the signal was an unread count: reading the thread
cleared it, so the queue drained itself. It stops being survivable when a flag
persists until somebody clears it deliberately — a queue with no way to take a
thread off it is a list that only grows.

So there is a `?view=attention` queue, a **Take this** button that assigns and
clears, and a release that is deliberately not symmetrical: it clears the
assignment and does not re-flag, because whoever took it may have finished and
re-raising the request every time somebody let go would make the queue
un-emptiable.

Taking it is a button and not something the thread page does while rendering.
Opening a conversation is how somebody decides whether they want it.

---

## At the tag

**The destructive policy audit.** RLS disabled on all 28 tenant tables, the
isolation suite re-run: **58 failed, 5 passed**. The five survivors are exactly
the five in the allowlist and nothing else — role attributes, fixture sanity,
two catalog facts about the owner, and the TRUNCATE grant. Unchanged from
Phase 2, so no sixth appeared.

All six new flow isolation assertions are among the 58, including "cannot
advance another company's run" — the write that matters most, because a run is
a position in somebody's conversation and moving it sends that customer the
next question in a tree they were never put into. They prove the boundary
rather than the convention.

Restored with `npm run db:nuke -- test`, never by hand: the migrations are the
only copy of that DDL worth trusting.

`packages/db/scripts/rls-audit.mjs` is the audit as a script now, rather than
three statements pasted into psql. It only ever DISABLEs and re-ENABLEs, so
there is no policy text to retype, and it refuses any database that is not
`whatsapp_os_test` on loopback — the same guard `db-nuke` carries, for a
sharper reason: this script's entire job is to take the boundary off.

**`npm run db:verify`** — clean on dev and test, all four catalog invariants.

**`prisma migrate diff`** — no drift.

**The gate** — green.

---

## Carried forward

- **A list-presentation question cannot be built in the editor yet.** The
  schema, the validator, the payload builder and the runtime all handle lists —
  ten rows across sections, with ids — and a version carrying one runs
  correctly. The editor renders a sentence instead of section controls. A flow
  needing more than three answers is expressible in the model and not yet
  drawable, which is a gap in one component rather than in the phase.
- **`collect` has no fixture.** The node kind works and is covered by the
  engine and runtime suites; the seeded tree does not use one, so no screenshot
  shows a customer typing a free-text answer into a flow.
- **Nothing re-points a lead-source binding at a newer flow version.** The
  binding names a version deliberately, and republishing a flow leaves it on
  the old one — which is correct, and means the page needs a control saying so.
  Today it is an edit-and-rebind.
- ~~A handoff does not assign the thread to anybody.~~ **Fixed**, and it was
  worse than the note said: the "marks the conversation unread" mechanism was
  itself the bug, because reading the thread undid it. See the handoff-signal
  section above.
- **Assignment is one person taking a thread, and nothing more.** There is no
  assigning to somebody else, no queue-per-user and no notification to whoever
  it lands on. `Take this` writes `assigned_user_id` to the person who pressed
  it, which is what clearing the flag needs and no more than that.
