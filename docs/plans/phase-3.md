# Phase 3 — KYC documents and the feature gate

Working plan, written as the phase ran. Status: **complete, `phase-3` tagged.**

Phase 3 was deferred past Phases 4a and 4b and returns here because A4 makes it
block everything else. A tenant uploads GST certificate, PAN card and Aadhaar;
a platform admin views, downloads and approves or rejects each one; and until
all three are approved the workspace can do four things and nothing else.

---

## What this phase is

A4, in full: **KYC is mandatory before any feature use.** The original plan
gated *sending* on verification. It now gates everything — not a banner, not a
degraded mode with the dangerous buttons hidden. Blocked.

What an unverified account can do, and this list is exhaustive:

```
sign up · sign in · sign out · Profile > Personal details
Profile > Documents · the verify-email flow
```

The sequencing consequence is the important half, and it is why this phase
moved: **a gate retrofitted onto entry points that already exist is a gate with
a hole in it**, and the one that gets missed is the one nobody notices. Landing
it before the remaining feature phases means each of those is written against a
gate that is already there — and against a coverage test that fails if they
forget.

---

## Settled decisions

| Decision | Resolution |
| --- | --- |
| Storage | `bytea` with `STORAGE EXTERNAL`, the MediaStore *pattern*, in its own table. Never `whatsapp_media` — see below. |
| Shape | Append-only, one row per upload attempt. The current state of a kind is the newest row for it. |
| The gate | `canUseFeatures(facts)` in `@whatsapp-os/core/kyc`. Pure, machine reason codes, no I/O. |
| Enforcement | Every page and every action calls it. Never the layout, never the nav. |
| `canSend` | Calls `canUseFeatures` rather than restating it, so the composer and the worker inherit one owner. |
| Blocked UI | A designed state that says what is missing and what to do. Never a redirect. |
| Revocation | An admin can withdraw an approval; the gate closes on the tenant's next request. |
| Validation | PDF by magic bytes, 5 MiB during the stream, enforced three times over. |
| Erasure | A per-company hard delete, behind the typed company name. DPDP. |

---

## The five things worth knowing

### 1. The table is not `whatsapp_media`, and the reason is tenancy

`whatsapp_media` is unique on `(company_id, sha256)` and upserts onto it. That
is right for one photo forwarded to fifty contacts and wrong twice here: two
companies filing the same PDF must never share a row, and one company re-filing
identical bytes after a rejection is a new attempt owed its own verdict.

So the *pattern* is reused — bytea, `STORAGE EXTERNAL`, a CHECK on length,
chunked `substring()` reads, the same `OUT_OF_BAND_DDL` entries — and the table
is not. `kyc.ts` became the eighth raw-SQL file, which is a deliberate diff in
`no-raw-sql.test.ts`. Generalising `media-store.ts` to take a table name would
have kept the count at seven and been a far worse shape: a raw SQL site whose
target comes from its caller.

There is **no `sha256` unique of any kind**, in either direction. Across
companies it would make one tenant's upload fail because of another's — an
existence oracle over identity documents. Within one company it would refuse
the re-upload of the very file an operator asked to have sent again.

### 2. Append-only, so the approval survives the replacement

The current state of a kind is the newest row for it. That ordering is written
down once, in `currentKycDocuments`, and shared with the two-column read the
send path uses through `newestByKind` — because two implementations of "which
row is current" is how a page comes to show one document while the gate decides
on another.

The consequence for every reader: **there is no "the GST document" row.**

### 3. The cap and the file type are each enforced three times

| | Cap | File type |
| --- | --- | --- |
| Outermost | `serverActions.bodySizeLimit` (6mb), refusing as the body arrives | — |
| Ours | `readPdfUpload`, abandoning the read at 5 MiB | first five bytes are `%PDF-` |
| Backstop | `kyc_documents_bytes_within_cap` | `kyc_documents_bytes_are_pdf` |

The outermost layer is the only one that can act *while the body streams*, and
it is not something a Server Action can do for itself — by the time the action
holds a `File`, the framework has already parsed the multipart body. So the
worst case reaching memory is 6 MB rather than whatever a client sends.

The two numbers differ deliberately: a request carrying a 5 MiB file also
carries boundaries, field names and a CSRF token, and a limit of exactly 5 MiB
would refuse a file at the documented maximum with a framework error instead of
our own sentence.

**The cap's test counts chunks, not just the verdict.** An implementation that
read everything and then refused returns the identical result. That difference
is invisible to an assertion on the outcome and is the whole distinction
between a cap and a memory exhaustion vector.

### 4. The gate is enforced per entry point, and a test says so

Twelve pages and six server actions call it. Not the layout — cached per
segment, not guaranteed to re-execute, so a check there is one a tenant can
navigate around. Not the nav — the URL still resolves and the action is still
reachable by its id.

`feature-gate-coverage.test.ts` walks `app/(app)` and fails in both directions.
The four permitted entry points are exempted by name with a reason each.

**That test was weak, and break-once found it.** It matched the bare identifier
`getFeatureAccess`, so replacing the call with a hard-coded `{ allowed: true }`
left the import behind and the check passed — a gate-coverage test that would
have watched the gate be removed. It strips imports now.

**And a source-level check has a ceiling.** Replacing the import with a local
no-op stub leaves every call site written, and no amount of parsing sees it. So
`feature-gate.test.ts` is the other half: a real action, a company that has
filed nothing, `canSend` saying yes to everything, and the assertion that no row
is written and nothing is enqueued. The two cover each other's blind spot and
**neither is sufficient alone.**

### 5. `REJECTED` covers a revoked approval, and the audit log does not

Approve, reject and revoke — and revoke writes `REJECTED`, because that is what
a withdrawn approval means downstream: not accepted, here is why, send another.
The enum stays at three members and the gate keeps one way to spell a closed
door.

What does *not* collapse is the record. `admin_audit_log` gets a distinct action
for a revocation, because "never accepted" and "accepted, then withdrawn" are
different events and the second is what an incident review is looking for.

---

## Corrections and things that went wrong

### C1. The pre-commit hook knew only half the fork crash

The first commit was refused with 63 test files reported, zero assertions
failing, and vitest dead before writing `report.json`. `is_crash_shaped`
matched only `"Worker exited unexpectedly"`, so the other documented
presentation of the same crash got no retry. Both signatures qualify now; the
second condition — no test reporting a failure — is untouched and still does
the real work.

### C2. A hand-restored CHECK constraint arrived mangled

Dropping `kyc_documents_bytes_are_pdf` to prove the constraint tests fail
worked exactly as intended: four failures, including the `OUT_OF_BAND_DDL`
sweep naming the missing constraint. Restoring it with a `node -e` one-liner
produced `'%5044462d'` rather than `'%PDF-'`, because a shell and a JS string
literal each ate one layer of the hex escape — and every valid PDF started
failing.

**The migration is the only copy of that DDL worth trusting.** The database was
rebuilt from it rather than patched again, which is the recorded remedy for
precisely this.

### C3. The gate reached rendering one commit before it was turned on

`canSend` consults `canUseFeatures`, so the composer began refusing and two
baselines moved on the commit that wired it — before any page enforced
anything. The visual fixture was verified there rather than with the
enforcement commit, and **not one baseline moved** as a result. That is the
right fact to have measured before a page depends on the data rather than after.

### C4. Two fixtures were testing the gate by accident

`conversation-send.test.ts` and `send-action.test.ts` both started failing when
`canSend` gained the gate: their companies had filed nothing. Their assertions
are about the window, the number status and the status ladder, and every one of
them would have passed or failed for the wrong reason.

Both fixtures are verified now — and because a fixture change that only makes a
suite green is worth nothing, the gate's own refusal is asserted deliberately
against a company that files nothing: a send every other precondition allows, an
approved template (the outside-window escape must not survive an unverified
company), a suspended workspace still reporting itself as suspended, and the
gate reopening on approval then closing again on revocation.

### C5. `vi.fn` with a zero-argument implementation types its calls as `[]`

Hit twice, in two different test files, and it typechecks nowhere while running
perfectly: `mock.calls[0][2]` is an index into an empty tuple. `npm run
typecheck` did not catch the first one — `next build`'s own TypeScript pass did.
Type the mock to the real signature.

### C6. The banner and the blocked page said the same sentence

Found by looking at the screenshot, not by any assertion. They are separate
strings now, with a test that they differ and that the banner is the shorter.

### C7. The revoke form was open on every approved card

The first recording of the admin Documents tab was 1706px tall and put the most
dangerous control on the page three times, at rest. It is behind a `<details>`
disclosure now; rejecting, which is the ordinary next step on a document
awaiting review, stayed on screen.

Both C6 and C7 are the argument for photographing pages rather than reasoning
about them.

---

## The tag

### The destructive policy audit

RLS dropped on every tenant table, `rls-isolation.test.ts` run, policies
restored, test database rebuilt afterwards.

| at | tenant tables | result |
| --- | --- | --- |
| `phase-4a` | 16 | 33 of 38 failed, **5 survived** |
| `phase-4b` | 18 | 37 of 42 failed, **5 survived** |
| **`phase-3`** | **19** | **41 of 46 failed, 5 survived** |

**The same five, and they are the five in `NOT_POLICY_TESTS`** — the two guard
tests, the role attributes, the ownership catalog fact, and the TRUNCATE grant.
No sixth, which is the finding the audit exists to produce.

The count held at five while the suite grew from 42 assertions to 46 and the
tenant tables from 18 to 19. So all four assertions added over `kyc_documents`
— including the one proving a chunked `substring()` read is refused across
companies — are proving the boundary rather than the convention.

### `db:verify`

Run against **both** dev and test at the tag. All four catalog invariants hold
on each, and both databases are at **30 migrations** with `kyc_documents`
present.

### Break-once

Nine breaks, all where a failure would be silent — the gate, the magic-byte
check, the cap, the authenticated route, and the irreversible delete. Not on
copy or layout.

| Break | Caught by |
| --- | --- |
| drop `kyc_documents_bytes_are_pdf` | 3 magic-byte tests + the `OUT_OF_BAND_DDL` sweep |
| chunk offset `+1` → `+2` | the multi-chunk round trip |
| `every` → `some` in `canUseFeatures` | 3, including the iterated any-single-kind case |
| delete `canSend`'s gate consultation | 3 send-path refusals |
| cap × 100 | the chunk-count assertion |
| disable the magic-byte check | 3, and the run took 7.4s instead of 7ms |
| remove the approved-document lock | the replacement refusal |
| replace `requireAdminSession` with a literal | 3, including the per-request count |
| remove the required rejection reason | all 3 reason assertions |
| remove a page's gate call | the coverage test, naming the file |
| stub the action gate locally | `feature-gate.test.ts` only |
| remove the typed-name comparison | all 3 erasure refusals |

Two of those found real weaknesses rather than confirming strength: the
coverage test's bare-identifier match, and its inability to see a locally
shadowed stub.

### The gate

`npm run verify` green at every commit. **1128 tests** at the tag, floor 886.
77 screenshots at 1440 and 390.

Two false reds absorbed on the way, both infrastructure: one fork crash in the
`report.json` presentation (which is what widened the hook), and one Playwright
run where the web server died mid-suite with `ERR_CONNECTION_REFUSED` across
every admin page — passed on re-run with no change to the tree.

---

## Carried forward

**The upload's exact cap runs over resident bytes.** `readPdfUpload` takes a
stream and abandons it at 5 MiB, but a Server Action receives a `File` that the
framework has already buffered — so the true during-the-stream guard is
`bodySizeLimit`, and the worst case in memory is 6 MB. Moving the upload to a
route handler taking the raw request body would make the exact cap streaming
too. Not done: it would be a second mutation mechanism in a codebase that has
exactly one, with its own CSRF story, for a 1 MB difference in the worst case.

**No tenant-facing download.** A tenant already has the document they sent, so
serving it back would add a second exit for these bytes and buy nothing. If
that changes, it is a second authenticated route and a second place to get the
headers right.

**Admin TOTP is still deferred to Phase 12.** It matters more now than it did:
a password alone protects a panel that can read every tenant's Aadhaar card.

**Erasure is per company and manual.** There is no retention policy and nothing
expires on its own. DPDP obliges deletion once the collection purpose is
served, which for an approved document is arguable and for a rejected one is
not — a scheduled sweep of superseded rows is the obvious next step and is a
policy decision, not a code one.
