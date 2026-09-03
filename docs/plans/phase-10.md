# Phase 10 — Meta Ads

Working plan, written as the phase ran. Status: **complete and tagged
`phase-10`.**

Amendment A3. Each client connects their own Meta account; their credentials
live per-tenant in the integrations section, exactly as the WhatsApp app secret
and verify token already do. Nothing is shared, and this app never holds a
credential that reaches across tenants.

What that deleted is Advanced Access and App Review for `ads_management` — two
to four weeks of Meta dependency on the critical path, with no fallback if the
review had failed. What it cost is everything in "Expiry" below.

---

## The commits

| # | Commit | Carries |
| --- | --- | --- |
| 0 | `8edb826` | the gate's retry, dead since `9a6917a` — before any feature work |
| 1 | `32d58de` | four tables, two columns, the PAUSED default |
| 2 | `1310217` | the Marketing API on the tenant's token, and expiry |
| 3 | `131baa6` | the stored expiry, the badge that acts on it |
| 4 | `68a7ac9` | ad account and Page selection, the linked-number check |
| 5 | `c4318b6` | the campaign builder, created paused, published deliberately |
| 6 | `7f2e323` | referral attribution |
| 7 | `b36afd9` | the insights sync and the ad-spend usage kind |
| 8 | `5d92f3b` | two dashboard cards, and one that would have started lying |

---

## Before any feature work: the gate's retry had been dead for a phase

The pre-commit hook decides whether a red gate was the known worker crash by
grepping the log, and what it grepped was the exact sentence `test-floor.mjs`
printed. Splitting the suite into two vitest invocations (`9a6917a`) made that
message name the half that died, so the string the hook looked for stopped
existing anywhere.

Nothing went red in between. The trigger lived in one file, the text it triggers
on lived in another, and no test joined them — so the guard was switched off by
a commit that had no reason to think it was touching one, and stayed off until
it refused a commit it exists to absorb.

**The general shape, which is the part worth keeping: a guard whose trigger and
whose text live in different files has a hinge, and nothing will tell you when
it moves.** The fix is a marker rather than a sentence — a token with no job
except being matched — plus a test that reads the patterns out of the hook and
runs them over the exact bytes the producer emits.

Measured rather than assumed: the old matcher, extracted verbatim and run under
`sh` against five fixture logs, refused exactly the case it existed to retry
and was correct on everything else.

---

## Expiry, which is what A3 bought the deletion with

Token lifetime stops being our internal detail the moment the tenant produces
the token. The failure that creates, if nothing tracks it, is the quiet one: the
token lapses, the sync fails, spend stops updating, and the dashboard keeps
showing last week's figure with nothing to say it is stale. Nobody notices until
somebody asks why the numbers stopped moving.

Three decisions:

- **A column, not a lookup.** `debug_token` could answer on demand. The badge
  renders on every page load, and the moment the answer matters most is the
  moment the call to ask has also stopped working.
- **Only `expired` demotes the badge.** An expiring token serves traffic
  perfectly well, and the documented operator response to NOT_CONNECTED is to
  re-enter credentials — so demoting a week early buys a week of people retyping
  a working secret. The banner says "act soon"; the badge says "it does not work
  now".
- **`debug_token` inspects the token with itself.** The documented caller is an
  app access token, which under A3 we do not have and must not have: it is
  precisely the cross-tenant credential the amendment removed.

`EXPIRY_TRACKED_KEYS` holds one key, and **`WHATSAPP_ACCESS_TOKEN` is
deliberately absent.** It can be a user token that expires in sixty days;
nothing records that and nothing warns. The set is named for what we do rather
than what the provider does, so the absence reads as the gap it is instead of a
claim that the token never lapses. Closing it is adding a key.

---

## Two mechanisms for PAUSED, and a measurement that changed a test's meaning

There is no undo for money Meta has already spent, so a campaign is created
paused by the column default AND by `createPausedCampaign`, whose input type has
no status field at all. Only one of the two is ours — Meta's API would take
ACTIVE from a caller that passed it.

**Measured, and it changed what one test means.** With the column default
deliberately altered to ARCHIVED, the ORM test still passed — and a raw INSERT
omitting the column in the same database landed ARCHIVED. Prisma Client sends
the value from `@default()` in the *generated* client rather than leaving the
column out, so **the database default is never consulted on the path the
application takes.**

So there are two tests and neither is sufficient alone: one covers every write
the app makes, one covers every write it does not — a migration, a backfill, a
psql session. The drift check found the altered default before any test file
loaded and refused the run, which is a third guard nobody had asked for.

---

## Money, three times over

- **Spend is per currency and never a total.** `spendByCurrency` returns a Map;
  a single numeric column invites a component written in a hurry to add ₹4,000
  to $50 and render 4,050 of nothing with the authority of a correct figure.
- **`spendToMicros` parses Meta's decimal string as text.** Number() is correct
  for small values and starts losing digits somewhere above nine billion micros
  — silently, and only for the accounts that spend the most.
- **`minorUnitsFromMicros` is exact or it throws.** A budget finer than the
  currency has two available roundings and both are decisions this code has no
  standing to make: down spends less than the tenant asked for, up spends more
  than they authorised.

**A locale bug a test caught.** `formatMicros` used
`toLocaleString("en-IN")`, which applies lakh-crore grouping to *every*
currency — so the USD account beside the INR one rendered `9,00,71,99,254`.
Worse for the suite: a locale-dependent formatter makes a rendered value depend
on the machine's ICU build, which is the conventions' rule about a rendered
value not coming from a developer's `.env`, one step further out.

---

## A window, not a cursor

The insights sync re-reads a window ending today on every run and upserts each
day. The obvious high-water mark is wrong for this data in a direction nothing
would report: **Meta restates recent days** as attribution windows close, so a
forward-only cursor keeps the first figure it ever saw for every day — and the
first figure is precisely the one most likely to be revised. The month settles
on a number that was never right and is never corrected.

`insightsSyncedThrough` is therefore a *report* of how far the last run read,
not an instruction to the next one. Nothing branches on it.

The unique index is what makes the re-read safe. Without it a nightly 28-day
window multiplies every figure by 28 — as an ordinary number, on a page where
everything else is right.

**The day is Meta's**, in the ad account's timezone. An account on
America/Los_Angeles has a different Tuesday from a platform day at +05:30, and
re-interpreting the string against our boundary would move spend between days on
every run — which looks like a reconciliation problem and is a timezone one.

---

## Attribution, and the flattering direction of its error

Meta attaches the referral block to the **first** inbound message of a thread an
ad started and to no later message in it. A reader that drops it has lost the
only join between money spent and a person who replied, permanently: their
Insights API reports spend per ad and has no idea which WhatsApp thread any of
it produced.

`contacts.source` is written at creation and **never overwritten**. A customer
who wrote in cold in March and clicks an ad in September is a lead the ad did
not create; re-stamping them would move a tenant's longest-nurtured contacts
into that ad's cost-per-lead denominator and make it look better than it was.
The one case worth filling in — a contact from before the column existed — is a
guarded `updateMany` with the null in its WHERE rather than a read-then-write.

The referral row *is* written for that returning customer. The ad should be
credited with the conversation; what it must not be credited with is having
found the person.

Two refusals: an empty referral block records nothing, and `source_type` is kept
verbatim so an organic post referral is never counted as an ad click.

---

## The linked-number check

A click-to-WhatsApp ad sends people to whatever number its Page is linked to. If
that is not a number this system can see, the ads run, the money is spent, and
nothing arrives — with no symptom anywhere except a quiet inbox.

So the check runs before the tenant commits, and its answer is a warning rather
than a refusal: an agency running ads for a business whose WhatsApp lives
elsewhere is an ordinary arrangement. It compares digits, because comparing
formatted strings reports a correctly linked Page as broken whenever the two
Graph endpoints disagree about punctuation — a false alarm on the one screen
where this warning is meant to be believed. Below ten significant digits a
suffix match is a coincidence, so it falls back to equality there: a false
*match* is the more expensive error, because it tells a broken setup it is fine.

---

## The dashboard obligation, both halves

The card this phase had to replace is the lead-source one, now "Where your
contacts came from". `unrecorded` is its own row and never folded into "wrote in
themselves": every contact predating this phase has a null source because
nothing was asking.

**And the card it did not replace would have started lying.** "Cost this month"
counts the usage events it could not price, because SUM ignores nulls and the
month would otherwise read as complete when part of it was never priced.
`meta.ad.spend` carries a null cost *on purpose* — the money is Meta's, already
charged, in the ad account's own currency — so left in, a tenant would see "56
events have no price yet" describing a gap in our pricing that does not exist.

The rollup excludes the kind by name, and ad spend gets its own card beside the
platform one. They are different debts owed to different people, and a tenant
reconciling an invoice needs to know which is which.

---

## The screenshots, and what only they caught

Three times, and each was an honest photograph of the wrong thing:

- The connect screen's first baseline was **"No Meta credentials stored"** — the
  seed gave the tenant no Meta integration, so the account list, the Page choice
  and the linked-number warning were not in the picture at all.
- The ad spend card's was **"no ad spend recorded yet"**, and the contacts card's
  only row was **"Before this was recorded — 32"**. Both correct; neither showed
  the feature.
- A `Remove` button stretching the width of its card.

None would have failed anything. The fixture now stores Meta credentials with an
expired token — which renders the tenant screens properly, renders the admin
card's expiry banner and demoted badge, and keeps the "not connected" state the
seed already valued for a better reason than an absent row.

**That pairing is not incoherent**, and it is worth saying why: our column
records what Meta said *when the token was stored*, and a token past that instant
can still work — Meta extends them, and a tenant can refresh out of band without
telling us. "Stored expiry has lapsed" beside "the Graph call succeeds" is a real
production state, and it is the one that makes a reconnect prompt worth having
rather than a hard failure.

The ad spend rows are stamped from the clock, deliberately: the card sums the
**current month**, so a literal date would fall out of the window and the card
would go to zero — a baseline that breaks with the calendar rather than with a
change. The date is never printed; the summed amount is, and that is fixed.

---

## A break that was unobservable, and why that is a finding

Rewriting the insights job to prefer a currency off Meta's response changed
nothing and no test failed. The reason is that `DailyCampaignSpend` has no
currency field at all — `campaignInsights` never parses one — so the guarantee is
structural rather than a choice the job makes.

The conventions are explicit that an unobserved break may mean the test is weak
rather than the break unobservable, and here it was neither: the test was
asserting a property held one layer down. It now says so, and asserts the half
that *is* live — forcing a literal currency in place of the account's does fail
it.

---

## At the tag

| Check | Result |
| --- | --- |
| `npm test` | **2,018 passed**, 2 skipped |
| `npm run test:visual` | **130 passed**, at both viewports |
| typecheck / lint / build | clean |
| Migration drift | only the HNSW index, waived by name |
| `npm run db:verify -- dev` | all four invariants hold |
| `npm run db:verify -- test` | all four invariants hold |
| Destructive policy audit | **exactly 5 survivors**, 73 failed |

The five survivors are the five in `NOT_POLICY_TESTS`: the role-attribute
guard, the fixture sanity check, the owner's attributes, the catalog ownership
fact, and the TRUNCATE grant. All ten new Meta Ads isolation tests failed with
RLS off, which is what makes them worth having.

### Breaks proved

| What | Assertion that failed |
| --- | --- |
| the hook reverted to the stale sentence | `gate-crash-matcher.test.ts`, naming both files |
| `is_crash_shaped` run verbatim under `sh` | five fixtures, all correct; the old one wrong on the one that mattered |
| the gate stubbed to emit the crash signature | `git commit` retried, dropped the page cache, refused on the second |
| the gate stubbed to emit a real failure | refused immediately, no retry, nothing in the tally |
| `expiryDemotesStatus` forced to false | the line held at expired rather than expiring |
| the Graph boundary forced to ACTIVE | `meta-ads.test.ts` |
| the column default altered to ARCHIVED | the raw-SQL default test; the ORM one did **not** — see above |
| the attribution guard's null removed | the returning customer re-stamped as an ad lead |
| the unpriced exclusion removed | the count went back to three |
| a currency preferred off the response | **nothing** — structural, and now recorded as such |

### What is not built

- **No ad sets and no creatives.** A campaign is created with an objective and a
  daily budget; the ad itself is still made in Meta's own tools. That is
  deliberate for a v1 — a creative editor is a media pipeline, an approval
  surface and a preview, and none of it is needed to answer "what is this
  costing and who did it bring".
- **No cost per lead on the dashboard.** The two halves exist —
  `spendByCurrency` and `leadsByAd` — and joining them needs an ad-to-campaign
  mapping this phase does not fetch. `leadsByAd` is keyed on the ad id Meta sends
  in the referral; insights are per campaign. The join is a Graph read per ad,
  and it belongs with the ad-set work rather than bolted onto a card.
- **`whatsapp_conversation_charges` and `meta_ad_insights` are not reconciled.**
  Phase 11 prices conversations against Meta's billing API, and that is where the
  two become one bill.
