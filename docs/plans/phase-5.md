# Phase 5 — Bulk messaging

Working plan, written as the phase ran. Status: **complete, `phase-5` tagged.**

A tenant uploads a contact list, maps its columns to an approved template, sees
exactly who will be messaged and what it costs, and sends. The run drips at a
controlled rate, can be paused, resumed and cancelled, and reports what happened
to every recipient.

---

## The constraint that shaped everything

**Bulk recipients are cold.** There is no open 24-hour window, so only an
approved template can be sent — free-form is not merely disabled here, it is
impossible. That fact is stated in four places, deliberately:

| Where | How |
| --- | --- |
| `sendPolicy` | already refuses free-form outside the window |
| `broadcasts.template_id` | `NOT NULL`, so a free-form broadcast is unrepresentable |
| the import screen | offers only `APPROVED` templates, so there is nothing else to choose |
| `handleBroadcastStart` | refuses to schedule an unapproved template at all |

**Nothing here is a second send path.** Every recipient goes through the
existing primitive: `canSend`, `attempts: 1`, the three-way outcome, UNCONFIRMED,
usage deduped on `messageId`. `materialiseRecipient` is where bulk stops being
special — after it, a recipient is an ordinary outbound message row and the send
job, the webhook and the inbox needed no change at all.

---

## Settled decisions

| Decision | Resolution |
| --- | --- |
| Model | `messages.broadcast_id` is the only thing marking a bulk send. Same ladder, same retry, same thread. |
| The audience | Its own table, because a draft cannot be message rows — see below. |
| Scheduling | Computed once at enqueue as `index * gap`, handed to BullMQ as `delay`. No scheduler. |
| Pause | Every send job re-reads the run's status. Nothing is removed from Redis. |
| The tier | Enforced at scheduling by capping to the remaining allowance, then pausing. |
| Import | CSV via papaparse, parsed **server-side**. XLSX deferred. |
| Media | **Deferred, and the composer copy changed.** See "What is not here". |

---

## The five things worth knowing

### 1. `broadcast_recipients` is an addition to the briefed model, on purpose

The brief said a recipient becomes an ordinary message row carrying
`broadcast_id`. That holds for a **sent** recipient, and `message_id` is where
the two meet.

What message rows cannot do is hold the audience *before* anybody has decided to
send it. An imported list has to survive the mapping step, the confirm step and
a browser refresh in the middle of them — and putting un-sent intent into
`messages` would mean either rows a worker might pick up, or a pre-send member
on `message_status`: a state describing rows that are not messages yet, in the
one enum every delivery callback and every retry already reasons about.

So the audience lives in its own table until it is sent, and then it is a
message. Nothing about the send path is duplicated.

### 2. The schedule is data, not a loop

Every recipient's send is enqueued with `delay = index * gap`. The queue holds
the plan, so a worker that dies and comes back finds every remaining send still
due when it was always going to be due. No scheduler, no ticking, nothing to
catch up on.

The alternative — a job that sends one and re-enqueues itself — is a chain where
every link is a chance to lose the rest of the campaign.

**The break that proves it matters is `delay: 0`.** In production that looks
like: every send succeeds, very fast, and the only symptom is a rate-limited
number and a damaged quality rating with nothing in any log to say why.

`scheduledSoFar` is why a resume carries a count. A resume that restarted the
schedule at zero would send the entire remainder in one burst — precisely when
somebody had paused because something looked wrong.

### 3. Pause is one UPDATE, because every job asks

Thousands of sends sit in Redis with their delays computed. Removing them would
be a slow, racy sweep of a structure being consumed at the same time. Letting
each job wake up and decline costs one indexed read and is exact.

The scheduling loop asks too, between batches — a pause pressed while ten
thousand recipients are being scheduled has to stop the *scheduling*, or Pause
leaves a queue that keeps draining for two hours.

A paused message is left completely untouched and stays PENDING, which is what
lets a resume re-enqueue it. A cancelled one is recorded as a refusal, because a
row with no status and no reason is the shape of a bug where "the campaign was
cancelled" is the shape of an answer.

### 4. The gap is pacing; the tier is the limit

Confusing them is the most likely misunderstanding in the phase, so the control
that could cause it says so on screen.

The gap shapes the rate and Meta has no opinion about it. The **messaging tier**
caps unique recipients per rolling 24 hours and no amount of slowing down gets
past it — a broadcast paced perfectly and larger than the tier does not fail at
the end, it fails partway through having already messaged part of the list.

So the run schedules up to the remaining allowance and **pauses**, rather than
throwing the remainder at Meta to be refused one message at a time. A RUNNING
broadcast that has quietly stopped sending is indistinguishable from a broken
one.

An unknown tier does **not** block. Failing closed there would be a
self-inflicted outage because a metadata refresh had not run, for a limit Meta
enforces itself.

### 5. The opt-out filter runs three times, and that is not redundancy

| Where | Because |
| --- | --- |
| import (`resolveAudience`) | so the confirm screen's count is true |
| materialisation | hours pass, and an earlier recipient of this very run can mark the same contact undeliverable |
| `canSend`, in the send job | the check that is true at the moment the message would actually go |

`contacts.undeliverable_at` is deliberately separate from `opted_out_at`. An
opt-out is the customer's decision and 131026 is a fact about a handset —
collapsing them would tell a business its own customers had unsubscribed when
somebody had typed a landline into a spreadsheet.

---

## Corrections and things that went wrong

### C1. The screenshot suite caught a real bug in the send path

`materialiseRecipient` never called `advanceConversation`. Every source-level
check passed. The picture showed sixteen bulk threads reading **"No preview"**,
sorting **above** the customers who had actually written in, because
`last_message_at` was null.

In production that is ten thousand blank threads on top of the inbox. It calls
it now — with `windowExpiresAt` still null, because a template does not open a
24-hour window and that is the one field it must not touch.

This is the clearest case yet for the rule that a rendered page reaches things
no source-level check does.

### C2. A gate-coverage list is a maintenance surface

Four new pages meant four entries in `feature-gate-coverage.test.ts` before it
would go green — which is the mechanism working. Worth noting for the phases
after this one: adding a section is now a two-file change by design.

### C3. `vi.fn` with a zero-argument implementation, again

Already recorded in the conventions from Phase 3, and it still caught the file
whose entire purpose is asserting BullMQ delays. `mock.calls[0][2]` is an index
into an empty tuple: it runs perfectly and fails to typecheck. Every mock in the
new worker tests is typed to its real signature.

### C4. The React compiler lint refuses `Date.now()` during render

It does not actually bite in a `force-dynamic` Server Component rendered once
per request, but the rule is syntactic and worth obeying rather than arguing
with. Extracted to a module-scope helper, with a comment saying which it was —
a syntactic dodge presented as a fix would be worse than the original.

### C5. `+44 7700 900123` is not a valid phone number

A test fixture, not the code. Ofcom reserves 07700 900xxx as a drama range and
libphonenumber correctly refuses it. The obvious "example" numbers for several
countries are reserved precisely so they route nowhere, which makes them the
wrong fixtures for a validity check.

### C6. A streamed CSV cannot reuse `toCsv`

The first chunk carries the BOM and the header and every later one must carry
neither. The version that strips them back off a `toCsv()` result breaks
silently the first time a field matches the pattern being stripped, so `csvRows`
was added to core instead.

---

## What is not here

### Outbound media (P4) — deferred, and the copy changed

The brief said to build it, and offered an escape hatch if it turned out to be a
phase of its own. **The condition is met and the hatch was taken deliberately.**

What it needs: a magic-number table across image, document and video with Meta's
per-type size caps; Meta's `/media` upload endpoint, which is a different call
with different semantics from anything in the system so far; a new send shape; a
composer upload control; and outbound rendering in the thread. The bytes come
from a **browser**, which is a completely different trust boundary from reading
a URL Meta gave us with our own token — and that boundary deserves its own
break-once discipline rather than being bolted onto the end of a large phase.

The composer control said "Sending files arrives in Phase 5" for two phases and
Phase 5 shipped without it, which is the failure mode a dated promise has: the
copy keeps its confidence while the date quietly stops being true. It now says
"Sending files is not available yet" and names no phase. **The next phase to
build this should delete the control rather than edit a date on it.**

### XLSX — deferred, with a note

SheetJS's npm `xlsx` package is deprecated on the registry; they publish from
their own CDN now. That is exactly the "heavy or poorly maintained dependency"
the brief said to refuse. The import screen says CSV only rather than leaving
somebody to discover it.

---

## The tag

### The destructive policy audit

RLS dropped on every tenant table, `rls-isolation.test.ts` run, policies
restored, test database rebuilt afterwards.

| at | tenant tables | result |
| --- | --- | --- |
| `phase-4a` | 16 | 33 of 38 failed, **5 survived** |
| `phase-4b` | 18 | 37 of 42 failed, **5 survived** |
| `phase-3` | 19 | 41 of 46 failed, **5 survived** |
| **`phase-5`** | **21** | **46 of 51 failed, 5 survived** |

**The same five, and they are the five in `NOT_POLICY_TESTS`.** No sixth. The
count has now held at five while the suite grew from 38 assertions to 51 and the
tenant tables from 16 to 21 — so all five added over `broadcasts` and
`broadcast_recipients` are proving the boundary rather than the convention.

The audience assertion is the one that matters most here: a recipient row
visible across the boundary would not merely be read, it would be **messaged**,
from the wrong company's number.

### `db:verify`

Run against **both** dev and test at the tag. All four catalog invariants hold on
each, and both databases are at **32 migrations** with both broadcast tables
present.

### Break-once

Nine breaks, all where a failure would be silent — the dedupe, the opt-out
filter, the pacing, the pause check, the tier cap, the back-off and the
undeliverable marking. Not on copy or layout.

| Break | Caught by |
| --- | --- |
| remove the in-file dedupe | 3, including three-spellings-of-one-person |
| narrow the back-off code set to one | the iterated all-four assertion |
| drop the headroom subtraction | 3 |
| remove the opt-out filter | 3 |
| `delay: 0` on every send | the pacing assertions |
| remove the pause check | 3, including the ordering one |
| remove the tier cap | 2 |
| remove the back-off | the iterated all-four assertion |
| remove the undeliverable marking | 2, including the non-broadcast case |

### The gate

`npm run verify` green at every commit. **1,206 tests** at the tag, floor 886.
**89 screenshots** at 1440 and 390, including the five the brief asked for:
import, mapping, confirm, a running broadcast and a finished one with real
failure rows grouped by reason.

---

## Carried forward

**A broadcast floods the inbox, and that is a direct consequence of the model.**
Reusing conversations means a 10,000-recipient run creates 10,000 threads, and
the inbox has no filter. The fixture shows it at sixteen; at ten thousand every
genuine conversation is buried. The model is right — a customer who replies must
land in the inbox beside everyone else — so the fix is a filter or a default
view, not a second table. **This is the most likely first complaint from a real
tenant.**

**The tier count is a floor, not a figure.** `uniqueRecipientsSince` counts what
this system sent; Meta counts from its own side including conversations we never
saw. The confirm screen says "about", and the back-off catches the rest.

**Nothing schedules a resume automatically.** A run paused at the tier limit
waits for a person to press Resume. A scheduled retry the next day is the
obvious next step and is a product decision, not a code one.

**Pricing is not configured.** Every price is zero at version 1, so the confirm
screen says pricing is not configured rather than showing a confident 0.00 that
would read as a promise this is free. Phase 11 wires Meta's real conversation
rates.

**`source_rows` is capped at 20,000 rows and 5 MB.** A larger list has to be
split. The limit is in the import action rather than a constraint, because the
only writer already enforces it and a `jsonb_array_length` CHECK would be
evaluated on every write of a large value.
