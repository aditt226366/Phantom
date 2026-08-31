# Phase 6 — Google Sheets as a lead source

Working plan, written as the phase ran. Status: **complete, `phase-6` tagged.**

A tenant binds a Google Sheet. Every row added from then on becomes a lead, and
an approved template goes out to it automatically, unattended, for as long as
the binding is on.

---

## The constraint that shaped everything

**A poll reads a spreadsheet somebody else is editing, on a schedule, for ever.**

That single sentence produces most of what follows. Bulk messaging is one list a
person watched go out; this runs for months with nobody looking, against a data
source that can be reordered, deleted from, re-sorted and re-typed at any moment
by a person who has never heard of a cursor.

So every mechanism above the database is an optimisation that can be wrong, and
the cost of being wrong is a real customer receiving the same WhatsApp message
twice. That cannot be un-sent and no apology undoes it. The guarantee is one
unique index, checked inside the transaction that writes the message:

```
UNIQUE (company_id, spreadsheet_id, tab, row_hash)
```

**Nothing here is a second send path.** A claimed lead goes to the same
`whatsapp.message.send`, under the same `sendJobId`, with the same
`SEND_JOB_OPTIONS` — `attempts: 1`, the three-way outcome, UNCONFIRMED, usage
deduped on `messageId`. `canSend` runs inside that job as late as a read can be.
The poll decides *who*; it has no opinion about *how*.

---

## Settled decisions

| Decision | Resolution |
| --- | --- |
| Idempotency | A unique index, in the claim transaction. Never a check-then-send. |
| Scope of that index | Per **(spreadsheet, tab)**, not per binding. See below. |
| The cursor | A count **and** an anchor hash. The count alone is wrong twice. |
| Scheduling | One BullMQ job scheduler per binding, carrying its `companyId`. |
| The action | A discriminated enum column from day one, with one member. |
| Backlog on activation | **Not contacted.** The cursor starts at the sheet's end. |
| Cleaning | `buildAudience`, reused. Not a second normalisation. |
| Materialisation | `materialiseOutboundTemplate`, shared with bulk. |
| Apps Script | Optional, collapsed by default. A doorbell that carries nothing. |
| Quota | Backed off in the **database**, so it survives a worker restart. |

---

## The seven things worth knowing

### 1. The cursor was a count until a test refused to pass

A count of rows already looked at is the obvious design, and it is wrong in both
directions with no error either way:

| What happens | What a bare count does |
| --- | --- |
| rows are **deleted** | the count is past the end of the sheet, `slice(count)` is empty **for ever**, and that binding never sends again |
| a row is **inserted** mid-sheet, or the sheet is sorted | everything shifts, so `slice(count)` returns a row already sent while the genuinely new one above it is never looked at |

Neither produces an error. The sheet is plainly being read; the only symptom is
leads that are never contacted, and nobody attributes that to a deletion three
weeks earlier.

So the cursor carries an **anchor**: a hash of the last row seen, over *every*
cell rather than the mapped ones. An append leaves it exactly where it was;
anything structural does not. Append is the shape a Google Form actually writes,
so the fast path stays fast, and everything else re-reads the sheet once and
lets the unique index do the deduplication it exists for. The rescan is a
one-off — the same poll leaves a fresh anchor behind it.

The anchor is deliberately **not** `rowHash`. They answer different questions:
`rowHash` asks whether this person has already been sent this message and
ignores unmapped cells on purpose; the anchor asks whether the sheet is the one
we left. Using `rowHash` for it would make it blind to exactly the edits it
watches for.

### 2. What the row hash does not cover is the load-bearing part

| Excluded | Because |
| --- | --- |
| the row's **position** | an insert at the top shifts every row below it, and a position-sensitive hash re-sends the whole sheet to everybody on it |
| the **unmapped cells** | a Notes column somebody types in is not a new lead |
| the **tab** | not because two tabs are one list — they are not, and the tab is in the unique *index* for exactly that reason. It stays out of the *hash* because a field cannot be added to digests already written |

It is length-prefixed rather than joined on a separator, because `["a:b","c"]`
and `["a","b:c"]` join identically and these are cells out of a spreadsheet — a
name with a colon in it is not exotic, and two leads sharing a hash means the
second is silently never contacted.

It carries a version tag. Changing what is hashed changes every hash, and every
row of every bound sheet then looks new — a WhatsApp message to every customer a
tenant has ever imported, with no migration and no undo. The prefix does not
prevent that; it makes the cause legible in a table rather than inferred from
thousands of duplicates.

### 3. The unique is per tab, and it took two goes to get right

It shipped as `(company_id, spreadsheet_id, row_hash)`, on the argument that two
bindings on one spreadsheet are more likely a mistake than an intent. That is
true of two bindings on the same **tab** and false of two on different tabs,
which is an ordinary setup: a workbook with "Website enquiries" and "Trade show"
as separate sheets, each feeding a different template.

Under the file-scoped key the second of those was **permanently dead**. Every
row it read collided with a hash the first binding had already claimed, it
counted duplicates for ever, and nothing it saw was ever contacted. Silent, and
the page's only account of it was a rising "already sent from this spreadsheet"
count that reads like a coincidence. It also collapsed two genuinely different
leads: the same person typed into two tabs hashes identically, and one of them
was never messaged.

`20260904090000` put the tab in the key. Two bindings on the same tab still
collide, which is the case worth protecting — that really is one list read
twice.

The tab is in the **index**, not in `rowHash`, and that is the load-bearing
half. A column can be added to an index; a field cannot be added to digests
already written, and re-hashing every stored row makes all of them look new —
a message to every customer a tenant has ever imported. The version prefix
exists to make that visible, not to make it cheap.

The cost, stated because it is a real change: a row **moved** between tabs is
now a new lead and will be contacted again. Moving a row between tabs is a
deliberate act on a list somebody is curating, and treating two tabs as two
lists is what makes the common setup work at all.

`company_id` leads the index, so two tenants whose sheets hold the same customer
never suppress each other. Every one of these has a test, and the cross-tenant
one matters because a unique violation is raised *before* a row is checked
against a policy — RLS alone would not catch it.

### 4. Activation starts at the end of the sheet, not the beginning

The decision most likely to be got wrong quietly, and expensive when it is. A
cursor left at zero means switching on a binding contacts every row **already**
in the spreadsheet — five thousand people who filled in a form eighteen months
ago, all at once, from a screen whose copy says "every new row becomes a lead".

So activation records where the sheet is now, from a live read rather than a
hidden form field a browser could change. The backlog has its own tool: bulk
messaging shows the counts, asks for a typed confirmation and paces the send,
which is the screen a decision to contact five thousand people deserves.

**The behaviour is right and the silence was the bug.** A tenant who binds a
sheet holding five thousand leads, presses Save and start and sees nothing
happen concludes the feature is broken — and they are not being unreasonable,
because the page says "every new row becomes a lead" and to them five thousand
rows are new. The mapping screen now states it in its own plate, with the count
of rows already present, and points at Bulk messaging for those. It renders
whether or not the mapping is finished, so somebody reading the screen for the
first time learns it before they have committed to anything.

### 5. One repeatable job per binding, because a sweeping poller is unavailable

The worker connects as `app_runtime` with no company context, so
`SELECT * FROM lead_sources` returns zero rows, succeeds, and looks exactly like
"nothing to do". A sweeper would run for ever and poll nothing, silently — the
same constraint that shapes `integration.verify` and `vault.reseal`.

So the fan-out lives where a company id can be established. The scheduler id is
derived from the binding id rather than random, because `upsertJobScheduler` is
an upsert on that key: a timestamped id would leave the old schedule running and
the binding would quietly poll twice as often. That is every other tenant's
quota problem before it is this tenant's, because Sheets meters reads **per
project**.

Pausing does **not** unregister the scheduler. The job keeps ticking and the
handler returns early, so re-enabling is one `UPDATE` rather than a
re-registration that could fail and leave a binding that says ACTIVE and polls
nothing — the worst of the three states, because it looks correct.

### 6. Three failure kinds, and they are not interchangeable

| Kind | Badge | Polling |
| --- | --- | --- |
| **quota** (429) | untouched | stopped until the back-off expires |
| **auth / config** (403, 404) | ERROR | stopped until the tenant fixes it |
| **transient** (timeout, 5xx) | untouched | continues |

A lost share is the single most common failure this feature has, and it must
present as an error on the page rather than as silence — a binding that cannot
see its sheet looks identical to one with no new leads, and the difference is a
customer list nobody is being contacted from.

A timeout never demotes. Demoting on a blip teaches people to ignore the state
that matters — the same argument `demotesStatus` was written for in Phase 2.

Quota is backed off in the **database**, not just in Redis, so it survives a
worker restart and the binding's page can say why nothing is happening.
`Retry-After` is honoured when Google sends it; a minute when it does not, and
deliberately not the poll interval, which may be ten seconds.

### 7. The Apps Script path is a doorbell

It carries no rows, no company id and no payload worth trusting. The poll it
triggers reads the sheet through the same credential and the same cleaning as
every scheduled poll, so there is no shape a request could take that puts a lead
into the system. The worst somebody holding the URL can do is make us read a
sheet we were going to read anyway, sooner — which is why it needs no signature:
there is no signed statement to make.

The company id comes from `app_resolve_company`'s seventh branch. That branch
**does** refuse a suspended workspace, which is the opposite of the `webhook`
branch above it, and both are deliberate: a Meta webhook resolves for a
suspended tenant because refusing costs them the subscription and every message
that arrived while they were suspended, and this bell only ever causes us to
send.

The key is per binding, not the integration's. Reusing that column would mean
one pasted script is a credential for every binding a tenant has, and rotating
it would silently break the WhatsApp webhook.

---

## What the screenshots caught

Two copy defects, neither visible to typecheck, lint, or any assertion:

- The lost-access page told the tenant to share with "the address above", and
  there was no address above. That sentence is written on the bind form, where
  it is true, then stored and re-rendered on a page where it is not. The address
  is now rendered on the error page too, which is where somebody reading the
  error actually needs it.
- The mapping screen promised "rows already in the sheet are contacted too",
  written before decision 4 and false after it.

And one collapsed element, caught by `css-utilities.test.ts` rather than the
picture: `max-w-xl` resolves to `--wa-space-xl`, so a paragraph would have
rendered 32px wide.

The mapping screen is the one page in the app that calls Google before it can
render, so it reads through `lib/lead-sources/sheets.ts`, which answers from a
literal when `LEAD_SHEET_FIXTURE` is set — by `playwright.config.ts` and nothing
else. Without it the gate spends the full ten-second provider timeout twice a
run and photographs an error state, so the screen most worth looking at would be
the one screen never looked at.

**That variable is a boot-time check, not a comment.** `webEnvSchema` refuses to
parse when it is set on a production deploy, and `parseEnv` exits non-zero, so
an environment that inherited it — a copied `.env`, a shared compose file, a CI
runner promoted to a deploy — does not come up. The failure it prevents is
quiet: a real tenant mapping their columns against five rows of a fixture, a
mapping that is structurally valid, and messages filled from the wrong columns.

The condition is **production mode *and* not serving the test database**, and
the second half was discovered by writing the first. `next start` is production
mode, so a guard on `NODE_ENV` alone refuses the screenshot suite — the only
legitimate consumer of the variable — which is how a check gets deleted rather
than fixed. An application serving `whatsapp_os_test` is not serving tenants.
The database name is parsed out of the URL rather than matched as a substring,
so `whatsapp_os_testing` is correctly treated as production.

It is deliberately **absent from `.env.example`**, which is the one exclusion
there that is a decision rather than an accommodation: that file is what a fresh
clone copies, so documenting the flag would hand it to every developer — the
exact inheritance the guard exists to stop.

---

## What is not here

- **XLSX and CSV lead sources.** Google Sheets only. A bound file has no
  equivalent of "somebody edited it", so it would need a different ingestion
  shape rather than another adapter.
- **A second action kind.** The discriminated field exists and has one member.
  A1's flow builder and A2's AI layer are the intended second and third.
- **Per-binding send pacing.** A lead source sends one message per new row, so
  the drip that bulk needs has nothing to pace here. The messaging tier still
  applies, enforced by Meta and by the send job's back-off.
- **Contacting the existing backlog from this screen.** Decision 4. Bulk
  messaging is where that belongs.

---

## At the tag

- **Destructive policy audit re-run.** RLS disabled on all 23 tenant tables;
  the isolation suite reported **52 failed, 5 passed**. The five survivors are
  exactly the five in `no-orm-in-isolation.test.ts`'s allowlist — role
  attributes, catalog facts, fixture sanity and the TRUNCATE grant. All six new
  lead-source isolation assertions failed as they must. Restored with
  `npm run db:nuke -- test`, never hand-written DDL.
- **`npm run db:verify`** run against **dev** and **test**. All four invariants
  hold on both.
- **`prisma migrate diff`** reports no difference on dev.
- Both databases were rebuilt after each migration in this phase, per A6.
