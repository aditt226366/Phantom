# Phase 4 — WhatsApp core

Working plan, updated as the phase runs. Written down because the decisions
below cost more to re-derive than to record, and several of them reverse
something that looked obvious.

Status: **4a in progress.** Schema, core and worker are complete. The web layer
has the webhook route, the media route, the visual fixture and the numbers page;
the inbox, the thread and the retry action are not built.

**Screenshots are back in the gate** as of commit 24. `.githooks/SKIP_VISUAL` is
deleted and every commit from here is photographed at 1440 and 390.

---

## What this phase is

Phases 1 and 2 built the substrate — tenant isolation in the schema, a
credential vault, provider adapters with an injectable `FetchImpl`, a usage
meter, an admin console that stores WhatsApp credentials. Nothing yet *used*
those credentials.

Phase 4 makes the product send and receive WhatsApp messages. It ships as two
tags.

**4a** — tunnel, webhook, numbers, and a working two-way inbox including the
outbound send primitive Phase 5's bulk queue will reuse unchanged.

**4b** — Template Studio and Meta's Template Library. Blocks nothing else,
which is why it is second.

---

## Settled decisions

| Decision | Resolution |
| --- | --- |
| Delivery | Split `phase-4a` / `phase-4b`. 4a carries the send primitive and the contacts/conversations/messages tables — the inbox reply needs all of it. |
| Send path | The composer enqueues; the worker sends. One primitive, reused verbatim by Phase 5. `canSend` runs twice — in the action for feedback, in the worker as the authoritative boundary. |
| Media | Postgres `bytea` behind a `MediaStore` interface, 5 MiB cap, sha256 dedupe, streamed and company-scoped on read. The interface is what makes moving to object storage a backfill rather than a rewrite. |
| Numbers | Child `whatsapp_numbers` table. `Integration @@unique([companyId, provider])` stays, because `integration_id` is an AAD component and relaxing it would be a decrypt-and-re-encrypt of every credential. |

Five amendments applied throughout: the closed-window composer shows a
**disabled** template picker rather than nothing; a failed send is a **visible
state** with `errorCode`/`errorTitle` and a retry action; `MediaStore` is an
interface with one implementation; contacts match on **`wa_id`**, not the
normalised number; read receipts are sent when a thread is opened.

---

## Corrections to decisions that were wrong

### C1. Decision 4's order of operations is not executable

The brief said "verify signature, resolve, enqueue, return". It cannot run that
way: `WHATSAPP_APP_SECRET` lives in the vault, the vault is company-scoped, and
there is no company scope before resolution. The executable order is:

```
raw = await request.text()
resolve webhookKey → companyId          (SECURITY DEFINER, no scope needed)
withCompany #1 → read sealed app secret → decrypt OUTSIDE the transaction
verify X-Hub-Signature-256 against raw
withCompany #2 → INSERT webhook event ON CONFLICT
enqueue → 200
```

The spirit survives — nothing processed inline, response immediate — but it is
two short transactions and a decrypt, not zero. Mitigated by P1.

The GET handshake has the identical constraint: `hub.verify_token` is in the
same vault. Both verbs share one resolve-and-open helper rather than growing
two orders that drift.

### C2. The webhook resolver must **not** check `deactivated_at`

Every other resolver kind does. This one deliberately does not.

> Every other kind answers "may this *person* act". This one answers "did this
> third party tell us something true". A suspended workspace's customers keep
> messaging it and Meta keeps delivering. Refusing resolution means a 404 to
> Meta, and after roughly seven days of failures **Meta disables the
> subscription** — so reactivating leaves a dead webhook nobody is told about,
> needing a human in Business Manager, with every message from the suspension
> gone.

Resolution succeeds; the **worker** declines and records
`skipped_reason = 'company_deactivated'`.

### C3. Message usage dedupes on our `messageId`, not the wamid

The wamid does not exist until Meta answers, so a send that times out and is
retried produces a *second* wamid for the same message row — two billable
events for one message, in the table that becomes an invoice.

### C4. Rule 3's raw-SQL list was a sentence, and it was wrong

Commit 16 needed a fourth sanctioned raw-SQL site — `GREATEST` has no
query-builder form, and splitting the window advance into three conditional
statements opens two gaps for concurrent webhook deliveries to interleave in.

Widening the list turned up that it had already been widened without anyone
saying so: `media-store.ts` has sliced `bytea` with `substring()` since
`20260815140000` and was never named. Nothing was unsafe — the slice runs
inside `withCompany` and has its own isolation tests — but a sentence claiming
to enumerate every site had been false for eight commits, which is the failure
mode a sentence has and a test does not.

So the list now lives in `packages/db/tests/no-raw-sql.test.ts`, compared in
both directions with a reason per entry, in the shape of `GLOBAL_TABLES` and
`COLUMN_GRANTS`. An eighth site is a diff in a security test. It found the
media-store omission before its first intended run.

Same commit, same shape: `status.ts` claimed a test executed its rendered
`CASE` against the database, and none did — the assertion inspected the string.
`status-ladder.test.ts` now executes it and compares the ladder to `pg_enum`
member by member, because a `CASE` missing one arm parses cleanly and returns
NULL, so a status added on one side only would stop advancing in silence.

### C5. The timestamp cast was documented, then deleted

Commit 16's raw statement had to write
`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'` on every bound value,
because Prisma maps `DateTime` to `timestamp(3)` *without* time zone — a wall
clock with no offset. Binding a `Date` and casting `::timestamp` keeps the
digits and drops the offset, writing a value out by the **node process's** UTC
offset, which here is four hours. The Postgres session is UTC, so bare `now()`
happened to be correct, and only for as long as that stays true.

Measured before acting: the digits Prisma writes and the digits the raw
statement writes were identical, so nothing was wrong in the database and
nothing needed correcting.

`05440ac` removed the class of bug instead of documenting it — 64 columns
across 22 tables to `timestamptz(3)`, drift clean, all at precision 3. Done
then because `ALTER COLUMN ... TYPE` rewrites the table under an ACCESS
EXCLUSIVE lock: instant on today's near-empty tables, a maintenance window on
Phase 5's message volume. `timestamp-columns.test.ts` holds an **empty**
allowlist, so the next `DateTime` field that omits `@db.Timestamptz(3)` fails a
test rather than quietly reintroducing the trap.

---

## The public-endpoint contract

The webhook is the only unauthenticated, internet-reachable, tenant-affecting
surface in the system.

### P1. The secret cache is bounded, invalidated and unprintable

In-process LRU, 256 entries, 60s TTL, holding the decrypted app secret and
verify token. Evicted explicitly when credentials are saved or the integration
is disconnected — the TTL is the cross-instance backstop, not the mechanism,
and saying only "invalidated on save" would be a false claim. Wrapped in a type
whose `toString`/`toJSON`/`inspect` return `[redacted]`, with a test.

### P2. An unknown key returns 200 and is recorded globally

**200, never 404** — a rotated key or stale Meta config would otherwise burn
toward the same disablement C2 avoids. Recorded in `unroutable_webhooks`
(global, in `GLOBAL_TABLES` with its reason), storing a **hash** of the key, the
reason, a hashed source IP, and never the body: the endpoint is
unauthenticated, so storing attacker-supplied payloads is a stuffing vector.

### P3. Throttled per source address, never per webhook key

**This reverses the original plan, which was an attack.** Keying the throttle on
the webhook key would let anyone who learns a tenant's URL flood it until that
key locks out — genuine Meta deliveries then refused, failures accumulating,
subscription disabled in ~7 days. An attacker severing a customer's WhatsApp
using our own protection.

So: `LoginScope.WEBHOOK` with a sentinel username and the hashed source
address, the shape signup throttling already uses, applied only to requests
whose key does not resolve or whose signature does not verify. A valid key with
a valid signature is never throttled. Routing it through `lib/auth/lockout.ts`
keeps the unscoped-client allowlist unchanged.

### P4. Outbound media is deferred to Phase 5, visibly

Inbound reads a trusted URL with our own token; outbound is a browser upload —
a different trust boundary needing file validation on user-supplied bytes and a
`POST /media` round trip. The composer renders a **disabled attach control**
saying files arrive in Phase 5, so the gap is visible and photographed.

### P5. A failed signature also returns 200

Same argument as C2, applied twice. A signature failure is what genuine Meta
traffic looks like when our stored app secret is stale. 403 to real deliveries
burns toward disablement; 200 to a forgery costs nothing because no work
happens either way. Recorded, throttled, surfaced.

### P6. Operator visibility is a commit, not a claim

P2 and P5 both end in "an operator sees it". Commit 26 adds 24-hour counts of
unroutable deliveries and signature failures to the admin Overview.

**What each path returns**, because it is not uniform and the asymmetry is the
point:

| | |
| --- | --- |
| unknown key, bad signature, throttled | **200** — not Meta, nothing to preserve, any non-2xx counts toward disablement |
| genuine but we cannot accept it | **not 200** — a 200 tells Meta the message was accepted and it will never resend |

---

## Risks

**R1 — the window moves backwards.** `windowExpiresAt` has the same
out-of-order problem as statuses and needs `GREATEST()`, never assignment.
`unreadCount`'s reset races an arriving message — **resolved in `1fdad02` by a
relative decrement rather than the conditional assignment first written here.**

The original prescription was `WHERE last_message_at <= $readAt`. It closes the
in-order race and misses two cases, both found while writing it:

- an inbound message delivered **out of order** increments the count without
  moving `last_message_at`, because that column advances with `GREATEST` — so
  the guard passes and clears a badge nobody saw;
- an **outbound reply** moves `last_message_at` too, so replying in that moment
  blocks the reset and leaves the badge up for one more open.

`SET unread_count = GREATEST(0, unread_count - $seen)` has neither. The reader
saw N; clearing exactly N leaves whatever arrived, in order or out of it, and no
predicate is needed because a decrement is order-independent by construction.
The clamp covers the one hazard left — a job that failed after the reset applied
and retried would subtract twice — which `readReceiptTarget` already bounds by
returning null at zero. Same instinct as `GREATEST` on the window, and it is
worth reading the two together.

**R2 — the retry button silently does nothing without a versioned jobId.**
BullMQ keeps completed ids for an hour and failed ids for a day. Hence
`sendAttempt` in the schema *and* in the job id.

**R3 — the `withCompany` extension does not merge `companyId` into `update`.**
Every upsert in the webhook worker must name it explicitly if its update arm
scopes anything.

**R4 — the inbox at 390px is the likeliest thing to fail `verify`.** Every page
is asserted narrower than the viewport before being photographed, and the two
faults this suite has caught were both automatic-minimum-size problems.
`lastMessagePreview` and `profileName` are that shape. Single-pane mobile
designed in, not patched after.

**R5 — `STORAGE EXTERNAL` is load-bearing.** Chunked `substring()` reads are
only server-side slices if the value is uncompressed.

**R6 — `/api/media/[mediaId]` is the first tenant read with no proxy
protection.** `isProtected()` is false for `/api/*`; its own `requireSession()`
is the only boundary. Asserted, not trusted.

**R7 — webhook burst is a pool problem, not a timeout problem.** `maxWait`
binds before the 5s timeout. Mitigations: the P1 cache, `maxWait: 1500,
timeout: 3000` on the event insert, and **return 200 even if that insert
fails** — the correctness guarantee is the wamid unique.

**R8 — the edit quota will be wrong.** Meta counts edits made in Business
Manager. The label reads "edits made here"; the Edit button is never the
enforcement.

**R9 — `whatsapp_webhook_events.payload` double-stores message text.**
Retention intent (30 days) is in the migration header rather than discovered by
a compliance question.

**R10 — `typedRoutes` sequences the commits.** A link to
`/inbox/[conversationId]` does not typecheck until the page exists.

**R11 — the coverage walker has never been exercised on a non-`[id]`
segment.** **Closed in `84a41f7`.** It was worse than "can never match": an
unmapped segment failed *both* directions of the coverage assertion, with two
messages that were each wrong — "nothing photographs them" when something does,
and "no page.tsx renders them" when one does. Whoever added the thread page
would have been debugging the walker rather than their page.

Now a `DYNAMIC_SEGMENTS` map plus the guard that is the real fix: a segment
still in brackets is its own named failure saying where to add it. Broken once
by deleting the `[id]` entry — it names the four company routes and the remedy,
and fires ahead of both older assertions.

---

## Commits

### Done — 4a (52 commits on `phase-4a`)

Planned commits 1–21 of the original numbering, plus ten that emerged from the
work and were not planned, plus the docs commits that wrote the rest down.

| # | Hash | Subject |
| --- | --- | --- |
| 1 | `9b85f75` | `chore: reach a dev machine from Meta's webhook delivery` |
| 2 | `e3c230f` | `feat(db): the phone numbers behind a WhatsApp connection` |
| 3 | `60dc227` | `feat(db): an opaque path Meta can post to` |
| 4 | `61f46f8` | `feat(db): resolve a company from a webhook path` |
| 5 | `c589da5` | `test(db): notice a grant nobody decided to give` |
| 6 | `4797a02` | `feat(db): contacts, conversations and the messages between them` |
| 7 | `f9cdeb2` | `feat(db): inbound media, stored once per file` |
| — | `80a7f52` | `test(db): sweep the DDL schema.prisma cannot express` |
| — | `38e0c09` | `test: refuse a run that collected fewer tests than it should` |
| — | `9c89295` | `fix(db): scope whatsapp_media, and notice the next model that is not` |
| 8 | `a5e91f9` | `feat(db): one way to read and write media bytes` |
| 9 | `e5a545b` | `feat(db): a record of every webhook Meta delivered` |
| 10 | `cf9b704` | `feat(db): notice a webhook nobody can route` |
| — | `c149dcd` | `docs: rule out heap as the cause of the fork crash` |
| — | `f24d90c` | `test: make a test worker unable to die quietly` |
| — | `8f5faab` | `test: set the shared database up once per run, not once per project` |
| 11 | `371d177` | `feat(core): the app secret a webhook signature needs` |
| — | `dd4232a` | `chore: run the gate where it cannot be piped away` |
| — | `74679d2` | `chore: retry the gate once, but only for the crash` |
| 12 | `b71487e` | `feat(core): verify a webhook really came from Meta` |
| 13 | `32d9558` | `feat(core): how a delivery status is allowed to move` |
| 14 | `0721ee4` | `feat(core): whether the 24-hour window is still open` |
| 15 | `5299e4f` | `feat(core): parse what Meta sends, and post back to it` |
| 16 | `809b41d` | `feat(db): whether a conversation can be sent to` |
| — | `05440ac` | `refactor(db): store instants, not wall clocks` |
| 17 | `9666eb7` | `feat(worker): turn a delivered webhook into a conversation` |
| 18 | `0064185` | `feat(worker): fetch inbound media before Meta's link expires` |
| 19 | `6e9abca` | `feat(worker): send a message and remember what Meta called it` |
| 20 | `1fdad02` | `feat(worker): mark a thread read when somebody opens it` |
| 21 | `d493d27` | `feat(worker): keep a number's quality and tier current` |
| 22+23 | `0601011` | `feat(web): protect the public endpoint before opening it` |
| 25 | `92af5bd` | `feat(web): the webhook Meta posts to` |
| 27 | `011f279` | `feat(web): serve a photo a customer sent` |
| 24 | `84a41f7` | `test(web): seed a WhatsApp number, a contact and two threads` |
| 28 | `8234da4` | `feat(web): the numbers behind your WhatsApp connection` |

**The batching.** Original commits 15–18 — payload parsing, `graphPost` and the
adapters, usage kinds, job contracts — were delivered as one commit (`5299e4f`).
Everything after shifts down by three, so the plan's 35-commit 4a is now 32.
Both numberings appear below where it matters.

### Remaining — 4a

**Every worker commit is done.** So is the fixture, and the numbers page —
taken ahead of 26, which renders and therefore lands under screenshots when it
comes.

| # (new) | # (orig) | Subject |
| --- | --- | --- |
| 26 | 29 | `feat(web): show an operator the deliveries that never landed` |
| 29 | 32 | `feat(web): a conversation list that says how long is left` |
| 30 | 33 | `feat(web): a thread, and a composer that closes with the window` |
| 31 | 34 | `feat(web): retry a message that Meta refused` |
| 32 | 35 | `chore: the third place a company id may come from` — tag `phase-4a` |

**What the fixture already holds**, so these four do not have to extend it:
three numbers across three states, two contacts, an open thread with two unread
and a closed one, an inbound image behind `/api/media`, and an outbound Meta
refused with 131047. The one constraint it imposes is C11 below.

**Webhook-key rotation is deferred and unscheduled.** The schema comment has
always put the control on Configuration > Numbers; commit 28 renders the URL and
stops there. Rotating drops every inbound message until the tenant has pasted
the new URL into Meta — accumulating exactly the failures C2 exists to avoid —
so it needs a confirmation step, copy that says so, and the P1 cache evicted
alongside. A commit, not a button.

### Remaining — 4b

`whatsapp_templates` and the edit log; the one component shape the preview and
the submission share; category price copy; create/read at Meta; the submit job;
the derived edit quota; the template-status webhook branch; the seed; the split
screen; submit-and-review; the Library tab; the template send that replaces
4a's disabled picker; the gate. Thirteen commits, tag `phase-4b`.

---

### C6. A probe column outlived its run, and only the test database noticed

`auth-schema.test.ts` began failing on a NOT NULL violation for
`email_verification_tokens.forced_failure` — a column in no migration, no
`schema.prisma`, and no source file. Only in `whatsapp_os_test`; `whatsapp_os`
was clean.

A deliberate break added it and its cleanup never ran, almost certainly killed
by the fork crash mid-run. Nothing noticed afterwards, and the reason is
structural: `migrate deploy` only applies migrations and never removes what a
migration did not create, and the drift check runs against the **development**
database, so a test-only mutation is outside everything that looks for drift.

Recovery is `npm run db:nuke -- test`. Worth knowing before diagnosing the same
symptom again, because it presents as a suite that was green an hour ago
failing in several unrelated files at once, with unique and foreign-key
violations that look like a broken feature.

Fixed in `d724b8c`. `migrate-test.mjs` diffs the test database against
`schema.prisma` before any test file loads and refuses the run, so the run that
*inherits* the stray object is the one that fails rather than the one after it.
A distinct exit code carries the diagnosis up to the Vitest globalSetup, which
prints last and would otherwise repeat "is Postgres up" over a database that is
demonstrably up. Both messages name `npm run db:nuke -- test`.

The conventions entry states the cause rather than the symptom: break-once
mutates the database, a killed process runs no cleanup, and no `finally` or trap
helps against that - so detection at the start of the next run is the durable
answer rather than prevention.

---

### C11. A screenshot fixture's rule is about *rendering*, not about the clock

`visual-seed.mjs` opens by saying every value in it is a literal, with one
exception stamped `now()`. Building the numbers page found two places that rule
was being read too narrowly, in opposite directions.

**A value nothing renders can still be random, and that is not safe — it is
merely undetected.** `Integration.webhookKey` defaults to a database expression,
so every seed run wrote four fresh random keys. Nothing had ever rendered one,
so nothing failed, and the seed had been non-deterministic for as long as it had
existed. Configuration > Numbers renders it, and the first run would have
produced a baseline that never matched twice — diagnosed, most likely, as a
flaky screenshot suite rather than as a fixture. Pinned now, in the same 32-hex
shape the default produces.

The same trap one layer out: `playwright.config.ts` derived `APP_URL` from
`BASE_URL`, and carried a comment saying the port was not rendered anywhere so
`VISUAL_PORT` could not invalidate a baseline. True when written. This page
prints the URL, so the escape hatch for a busy port became a silent re-record.
`APP_URL` is a literal now, and the comment says why.

**And the converse: a value the clock decides is fine, as long as it is never
printed.** The open thread cannot be both permanently open and described by a
fixed instant — a literal in the future becomes a literal in the past, and the
composer this fixture exists to photograph closes for good on a date nobody
wrote down. So `window_expires_at` is `now() + 18 hours` while
`last_inbound_at`, `last_message_at` and the preview stay literal, because those
are what the inbox prints.

That is the rule, stated properly in the seed's header: **a value here may be
decided on at render time, and may never be rendered as a time.** The usage
events already had that licence; the window now shares it. The consequence
belongs to commits 29 and 30 — render the window as the open/closed state it
determines, or as a bucket coarse enough that the minutes between seed and
screenshot cannot move it. Never as a timestamp.

### C10. The dev database had drifted, and nothing was watching it

Running the webhook end to end turned up a 500 on the bad-signature path that
no unit test could see: `permission denied for table unroutable_webhooks`.

Not the code. The **development** database was missing two of the three column
grants `20260815160000` creates — `webhook_key_hash` and `attempt_count` — and
those are exactly the two Prisma's upsert reads, one as the `ON CONFLICT`
arbiter and one for the increment. The test database had all three, which is
why the db suite passed throughout.

Repaired in place with the two `GRANT SELECT (…)` statements rather than by
nuking, since dev holds fixtures.

The gap is the same shape as C6 and on the other database. `prisma migrate
diff` cannot see column grants at all — they live in `pg_attribute.attacl`,
which is why `COLUMN_GRANTS` exists in `schema-invariants.test.ts` — and that
test runs against `whatsapp_os_test`. So nothing checks dev, and a drifted dev
database presents as a route that works in tests and 500s in a browser.

Not fixed here. The cheap version is pointing the same catalog assertions at
dev behind a flag, or a `db:doctor` script an operator runs when something
works in tests and not in the app.

### C9. A send that times out gets a status, not a marker

The third outcome of a send had no home. Meta's /messages has no idempotency
key and no "did this land" lookup, so a timeout after Meta processed the
request is indistinguishable from one before it did — which is why the job runs
with `attempts: 1`, and which leaves a row the ladder could not describe.

Not `FAILED`: we do not know it failed, and a failure invites a retry as though
it were free. Not `SENT`: we do not know that either. Not bare `PENDING`: that
is the stuck-forever bubble in a new costume.

The cheap option was `PENDING` plus a distinct error code. Rejected on a query
rather than a rendering — this schema already says *"the send worker claims rows
by status"* over `@@index([companyId, status])`. Anything claiming work that way
selects `PENDING` and sends it, so a marked `PENDING` row is one forgotten `AND`
clause away from the duplicate send `attempts: 1` exists to prevent.

So `MessageStatus.UNCONFIRMED`, added in `20260816120000`, ranked between
PENDING and HELD. `errorTitle` carries *"delivery unknown — check WhatsApp
before sending again; retrying may send this message twice"*; `errorSource`
stays **null**, because nobody refused it — Meta said nothing and we did not
decline, and a populated title beside a null source is the shape that means "no
verdict".

Nothing will ever move it on its own. There is no wamid, so no callback can
match the row; if Meta did send it, the callbacks arrive for a wamid we do not
hold and are dropped by C7. Only a person can resolve it, and no usage is
recorded — under-billing by one message is the right way round to be wrong.

### C8. `WhatsAppNumberStatus` was our enum for Meta's vocabulary

Applying commit 15's own test consistently, one column late. Meta defines this
set and documents more of it than we modelled — `BANNED`, `MIGRATED`,
`RATE_LIMITED` and `UNVERIFIED` beyond `CONNECTED`/`PENDING`/`FLAGGED`/
`RESTRICTED`.

Not the crash hazard `message.type` was: the `UNKNOWN` member absorbed a
surprise and the write succeeded. It succeeded by **discarding the answer** — a
number Meta had banned was stored as "we don't know" — which is precisely what
made `messagingTier` and `throughputLevel` text in the same table. This column
was left behind.

`QualityRating` stays an enum. `GREEN`/`YELLOW`/`RED`/`UNKNOWN` is a closed
traffic light, not a state machine Meta keeps extending.

Done in `20260816100000`, which also drops the orphaned type. A type swap rather
than a data migration — the table is effectively empty, `USING status::text` is
exact, and nothing writes the column yet. **The timing is the point:** the
refresh job (commit 21) is the first writer, and doing this afterwards would
mean changing the column, its writer and its reader across three commits with a
live consumer in between.

The consequence for the send path, which is the half a type change hides:
`sendPolicy` now splits its refusal. A status we model and know cannot send
reports `number_not_sendable`; anything else — `UNKNOWN`, or anything Meta adds
after this build — reports `number_status_unknown`. Both fail closed, so the
safety is unchanged; what differs is that the refusal no longer claims knowledge
we do not have. The real value is stored verbatim for display.

### C7. An orphan status is accepted and recorded, not queued

**Decided before the send worker, because it changes what that worker does.**

The race: Meta can deliver a status webhook for a wamid before the send job has
finished storing it. `applyStatusUpdate` finds no row, returns
`no_such_message`, and that callback is gone — nothing redelivers a webhook we
answered 200 to.

**Resolution: accept the loss, and say so where the branch is.** No
`orphan_statuses` table. Four reasons, in the order that decided it.

**1. The worst case does not occur, because the floor is our write.** The
worry is a bubble stuck on `PENDING` for ever — a message that is sent and
never delivered, where `sent` is the only callback that will ever arrive. That
cannot happen here: the send worker writes `SENT` (or `HELD`) from
`SendAccepted` itself, in the same update that stores the wamid. The status
floor is set by the Graph response, not by the webhook, so a lost `sent` is
redundant rather than load-bearing.

**2. The residual harm is an understated thread, and needs an implausible
ordering.** What a lost callback can still cost is `DELIVERED` or `READ`: the
ticks stay grey on a message that arrived. But `delivered` is only generated
after Meta hands the message to the handset, which is after the response we are
already committing — so to lose it, the whole chain (handset ack → webhook →
our endpoint → event insert → enqueue → worker → ingest) has to beat one UPDATE
that is already in flight. Possible under a pool stall; not ordinary. And
`read` usually arrives minutes later, when a human opens the chat, which
rescues the thread on its own — the ladder is monotonic, so `READ` applies
whether or not `DELIVERED` was seen.

**3. The table is not self-cleaning, which is the argument that actually
kills it.** `no_such_message` fires mostly for wamids that will *never* be
ours — a message sent from Business Manager, where a human replied from Meta's
own console. Nothing drains those: the send worker only ever claims wamids it
wrote. So the table needs a retention job on day one, and "bounded and
self-cleaning" is true only for the rare case and false for the common one.
It also puts an extra read on the send path immediately after the Graph call,
which is the one place this phase has been most careful about (R7).

**4. The gap is already instrumented, so it does not have to be guessed at.**
Every occurrence is recorded as `status_no_such_message` on the webhook event,
and P6 (commit 26) puts those counts on the admin Overview. If this stops being
rare, it shows up as a number an operator can see, rather than as a thread
somebody eventually notices is wrong.

**What would reverse this.** If the send worker ever stops writing the status
from the Graph response — if `SENT`/`HELD` come to depend on the callback
instead — then reason 1 disappears and with it the whole argument. Anyone
making that change is choosing this decision again, and the comment on the
branch in `conversations.ts` says so.

---

## Process, as it now stands

**The gate runs in a pre-commit hook.** `.githooks/pre-commit`, wired by a
`prepare` script setting `core.hooksPath`. It exists because piping `npm run
verify` to `tail` swallowed a red gate three times — a pipeline's exit status is
the last command's. Redirect, never pipe.

The hook retries **once**, and only for the known worker crash: the worker-exit
signature present *and* no test reporting a failure. A genuine red never gets a
second roll. Retries append to `.git/gate-retries.log` and the count is printed,
so a rising rate surfaces itself.

**Screenshots are back on.** `.githooks/SKIP_VISUAL` was deleted in `84a41f7`,
the commit its own text named by title, and the hook runs the full `npm run
verify` again. The marker worked as intended: a file rather than a hook edit, so
the state showed in `git status` throughout and was undone by deleting
something.

The seed commit was the right place to restore it, and the run proved why —
the fixture grew by seven tables and **not one baseline moved**, which is a
fact worth having before a page depends on that data rather than after.

**The test-count floor** (`npm run test:gate`) refuses a run that *collected*
fewer tests than the committed minimum. It guards the silent case — a deleted
file or a project dropped from the config exits 0 with fewer tests. A crashed
worker is a different failure and already exits non-zero. Currently 700.

**Break-once is now narrowed** to where a failure would be silent: isolation,
data loss, money, auth, the send path. Not copy or formatting. Two corollaries
learned the hard way — a deliberate break must prove it broke something (assert
the anchor matched), and some breaks are provably unobservable and should be
recorded as such rather than chased.

---

## Still queued

**The fork-crash investigation is stopped by agreement.** Nine-plus occurrences,
always the db project, always `auth-schema.test.ts`, always full runs. It exits
non-zero, so it fails loudly, and the retry absorbs it at a recorded rate.

Ruled out, each by measurement rather than argument:

- **Not heap.** `--logHeapUsage` over all db tests: the post-GC floor does not
  climb — 37–40 MB for db-touching files, 12–16 MB for catalog-only ones, and
  the second-half average is *lower* than the first.
- **Not `parseEnv`.** Walking `auth-schema.test.ts`'s import graph — 41 files —
  finds no call. `migrate-test.mjs` does exit, but is a spawned child checked
  through `result.status`.
- **Not the double `globalSetup`.** Real, and fixed by hoisting it to the root
  config; the crash continued at 2 in 5.
- **Not anything at the JavaScript level.** With `tests/no-silent-exit.ts`
  installed, crashed runs produce no `SilentExitError`, no `unhandledRejection`,
  no `uncaughtException` and no Node fatal message. The guard's silence is the
  evidence: the worker dies below JavaScript, which is why nine occurrences have
  never yielded a stack.

Remaining suspect is contention between `db` and `web-server` over the shared
test database. Unproven, and the next step if it is ever picked up again is
capturing the worker's actual exit code at the OS level.
