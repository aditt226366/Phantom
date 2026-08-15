# Phase 4 — WhatsApp core

Working plan, updated as the phase runs. Written down because the decisions
below cost more to re-derive than to record, and several of them reverse
something that looked obvious.

Status: **4a in progress.** The schema and the core layer are complete; the
worker and web layers are not.

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
`unreadCount`'s reset races an arriving message; reset with
`WHERE last_message_at <= $readAt`.

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
segment.** `pages.spec.ts` substitutes only `[id]`; anything else stays literal
and can never match. Commit 24 replaces the ternary with a map.

---

## Commits

### Done — 4a (28 commits on `phase-4a`)

Planned commits 1–20 of the original numbering, plus nine that emerged from the
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

**The batching.** Original commits 15–18 — payload parsing, `graphPost` and the
adapters, usage kinds, job contracts — were delivered as one commit (`5299e4f`).
Everything after shifts down by three, so the plan's 35-commit 4a is now 32.
Both numberings appear below where it matters.

### Remaining — 4a

| # (new) | # (orig) | Subject |
| --- | --- | --- |
| 18 | 21 | `feat(worker): fetch inbound media before Meta's link expires` |
| 19 | 22 | `feat(worker): send a message and remember what Meta called it` |
| 20 | 23 | `feat(worker): mark a thread read when somebody opens it` |
| 21 | 24 | `feat(worker): keep a number's quality and tier current` |
| 22 | 25 | `feat(web): throttle a public endpoint the way we throttle sign-in` |
| 23 | 26 | `feat(web): hold a webhook's secret briefly, and drop it when it changes` |
| **24** | **27** | `test(web): seed a WhatsApp number, a contact and two threads` — **screenshots back on here** |
| 25 | 28 | `feat(web): the webhook Meta posts to` |
| 26 | 29 | `feat(web): show an operator the deliveries that never landed` |
| 27 | 30 | `feat(web): serve a photo a customer sent` |
| 28 | 31 | `feat(web): the numbers behind your WhatsApp connection` |
| 29 | 32 | `feat(web): a conversation list that says how long is left` |
| 30 | 33 | `feat(web): a thread, and a composer that closes with the window` |
| 31 | 34 | `feat(web): retry a message that Meta refused` |
| 32 | 35 | `chore: the third place a company id may come from` — tag `phase-4a` |

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

Not fixed here, and it is a real gap: nothing runs the drift check against the
test database. The cheap version is a `migrate diff` against it in
`migrate-test.mjs`, which would fail the run that inherits a stray object
rather than the one after it.

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

**Screenshots are off**, via the committed `.githooks/SKIP_VISUAL` marker, which
switches the hook to `npm run verify:no-visual`. A file rather than a hook edit,
so the state shows in `git status` and is undone by deleting something. It comes
off at the visual-seed-harness commit — **24** in the new numbering, 27 in the
original, which is what the marker names by title. Typecheck, lint, build and
the full vitest suite with its floor all stay in.

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

**`WhatsAppNumberStatus` should be text, not an enum.** Applying commit 15's own
test consistently: the vocabulary is Meta's — `CONNECTED`, `PENDING`, `FLAGGED`,
`RESTRICTED`, and Meta also documents `BANNED`, `MIGRATED`, `RATE_LIMITED`,
`UNVERIFIED`. The `UNKNOWN` member absorbs surprises without failing the write,
so it is not the webhook-crash hazard `message.type` was, but it silently
discards the real value — the thing `messagingTier` was made text to avoid.
`QualityRating` is genuinely closed and fine as an enum.

Do this **before the numbers refresh job** (commit 21), which is the first code
that writes the column.

Commit 16 is the first code that *reads* it, and does not constrain the change:
`canSend` passes `whatsapp_numbers.status` to `sendPolicy` as a string and
compares it against a `Set`, so the column becoming text is invisible to it.
The four-line `numberStatus` fixture in `conversation-send.test.ts` is the only
thing that would need looking at.

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
