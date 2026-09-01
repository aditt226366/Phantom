# Phase 9 — The tenant dashboard

Working plan, written as the phase ran. Status: **complete, `phase-9` tagged.**

The Dashboard section had been an empty state since Phase 1 while five features
sent, received, scored and spent on the tenant's behalf. This makes that
visible. Every figure comes from the database; nothing on the page is a
placeholder.

---

## The constraint that shaped everything

**Every number on this page is an aggregate over the two tables that grow
fastest, on the one page people leave open on a second monitor all day.**

Computed at render time that is six sequential scans of `messages` per page
load, per viewer, per refresh. The obvious answer is to cache the page, and it
is the wrong one: a cached page is stale in a way nobody can see.

So the numbers are recomputed on a schedule, the moment they were computed is
stored beside them, and the page prints how old they are. Staleness that is
visible is a fact the reader can weigh. Staleness that is hidden is a lie with a
timestamp on it.

The corollary shapes the rest: **anything whose cost does not grow with history
stays live**, because a seek returning ten rows does not get cheaper for being a
minute old, and it does get wrong.

---

## Settled decisions

| Decision | Resolution |
| --- | --- |
| Where the aggregates live | `dashboard_rollups`, **one row per company** |
| Why one row | One `computed_at` has to cover everything above it |
| Refresh | `dashboard.rollup`, a scheduler per company, every 60s |
| Who registers it | The signup action, and a backfill script — never the worker |
| The four action cards | **Live**, read per request, no freshness line |
| Currencies | A map, never a total. No exchange rate exists in this system |
| Micros in `jsonb` | **Strings.** JSON numbers are doubles; `cost_micros` is a bigint |
| Failure grouping | Stored by Meta's code, grouped in TypeScript |
| "Today" | The platform day, Asia/Kolkata, labelled IST wherever shown |
| Data that does not exist | An honest card naming the section, never a zero |
| Charts | Inline SVG on `--wa-*` tokens. No charting dependency |

---

## The six things worth knowing

### 1. One row per company, because a freshness stamp has to cover its subject

Split across a scalars table, a per-currency table and a per-source table, a
refresh can succeed for some and fail for others — and the page then prints one
"as of" line over a mixture of two moments. That is worse than being stale,
because it looks consistent.

One row, one upsert, one `computed_at`. Everything on the rolled-up half of the
page was true at the same instant or none of it was. The two figures that are
genuinely a set rather than a scalar — spend per currency, failures per Meta
error code — are `jsonb` columns **on that row** for exactly the same reason.

It is the first entry in `SINGLE_ROW_PER_COMPANY_TABLES` in
`schema-invariants.test.ts`: with one row per company the primary key is the
whole lookup, so the composite-index rule has nothing to add and a
`(company_id, computed_at)` index would describe a read nothing performs. That
waives the composite clause and nothing else — `company_id`, RLS, both policies
and the grants are all still asserted for it.

### 2. The refresh is the ninth raw-SQL site, and the reason is the snapshot

Through the query builder it is nineteen round trips: a count per direction, one
per member of the delivery ladder, a grouped scan for the source distribution,
two grouped scans to work out who replied, a sum per currency, a count of the
unpriced.

Nineteen round trips is nineteen passes over `messages` — the table this phase
exists to stop scanning — and they do not see one snapshot, so the `computed_at`
stamped over them would be a claim none of the figures individually supports.
`FILTER` and `jsonb_object_agg` have no query-builder form.

The statement writes `company_id` from `app_current_company()` rather than from
a bound parameter. It runs inside `withCompany`, so the two would agree — taking
it from the transaction-local setting means they *cannot*.

### 3. Four CHECK constraints do work no test could

The delivery card is presented as a partition of everything the tenant tried to
send. That claim is enforced by the database:

```sql
outbound_pending + outbound_unconfirmed + outbound_held + outbound_sent
  + outbound_failed + outbound_delivered + outbound_read = messages_outbound
```

A `FILTER` clause that overlaps or misses a status makes the chart quietly not
add up, and one statement computing all seven is the only thing that would ever
notice. Proved: narrowing the outbound count by one status is refused with
`23514`, not by an assertion.

### 4. The planner claim in the brief did not survive EXPLAIN

The brief asked for every windowed bound to be computed in TypeScript on the
premise that an inline `now()` estimates `rows=1` and loses the index — 63x on
the closing-windows query.

**It does not reproduce.** `now()` is `STABLE`, not `VOLATILE`: its value is
fixed for the duration of a statement, so the planner evaluates it while
planning and estimates the range from the histogram exactly as it would a bound
parameter. Measured on Postgres 17.11 over 50,000 seeded conversations, the two
forms produce the *same* Index Scan on `(company_id, window_expires_at)` with
the same row estimate.

`npm run db:explain:dashboard` prints both plans side by side, as `app_runtime`
with the company context set — RLS ANDs its predicate in before the planner sees
the query, so a plan measured any other way is a plan for a different query.

The bounds stay arguments anyway, for three reasons that are real:

- the platform day has no SQL form, and writing one would hardcode `+05:30`;
- every exact-count assertion in the db suite passes a fixed instant;
- `computed_at` has to exist outside the statement that used it, so the page can
  compare the day it counted against with the day now.

The rule still holds for a genuinely volatile bound. `now()` is not one.

### 5. Freshness has three states, and the third catches what the first cannot

`never` is its own member, not an infinitely stale reading: a company whose
rollup has not been computed must not be shown zeroes, because "nothing
happened" and "we have not counted yet" are different claims.

And `countedDayIsCurrent` is a second check beside it, because at 00:04 IST a
rollup computed at 23:59 is five minutes old — perfectly fresh — and its "new
today" is a complete count of *yesterday*. The rollup stamps the platform-day
boundary it counted against, and the page compares it. Two checks, two faults,
and only one of them looks wrong.

### 6. Nothing renders a zero it cannot support

AI handling, lead temperature, the pyramid and orders carry no figure at all —
a card saying what will appear and which section brings it.

"Orders: 0" reads as a business with no orders, not as a product with no order
tracking, and there is nothing on the page to tell those apart. A tenant who has
been messaging customers all week and sees a dashboard reporting zero orders has
been told something false by a page whose every other figure is true.

They name a **section** and not a phase number, because `spec-amendments.md` is
explicit that the numbers need one deliberate renumbering pass — a number in
user-facing copy would be wrong on the day it happens and would be the last
place anybody looked. Where nothing owns a capability yet, the copy says "Not
built yet" rather than inventing an owner.

---

## What the screenshots caught

Five things, and four of them were invisible to every source-level check.

**The donut was one solid ring.** `ink` (#0c0a09) and `body-strong` (#292524)
are adjacent in the type scale and all but identical as fills, so a two-segment
chart rendered as a circle that said nothing. The ramp now steps in visible
increments. *Adjacent steps must be distinguishable side by side*, which is a
stronger requirement than being distinguishable in a paragraph.

**"1 were delivery-limited by Meta."** Three counts, three verbs, each able to
be one. It is a list now, which has no verb to get wrong.

**The broadcast fixture was lying.** Its failures carried `error_source = META`
and a NULL `error_code`, under titles that were Meta's own wording for specific
errors — "cannot receive WhatsApp messages" *is* 131026. Nothing read the column
until this page grouped by it, at which point the gap surfaced as a breakdown
reporting every failure as "other" while the titles beside it named two distinct
causes. They carry their codes now, and one is 131049 so the delivery-limited
group is exercised rather than asserted.

**Three values would have ticked**, and the third was found only by running the
suite twice:

| Value | Was | Is |
| --- | --- | --- |
| Rollup freshness | a growing age | no digit at all while the refresh is running |
| Time to window close | `8 min` | one of three buckets |
| The inbox badge | `45m left` | the same three buckets, via `windowBucket` |

The inbox one is the interesting one, because it was latent long before this
phase. Its own test asserted `"45m left"` under a comment saying the value "may
never render an instant — only a bucket". Both were wrong together, and nothing
caught it because no fixture had ever seeded a near-term window. Phase 9 seeded
three and both inbox baselines moved ~190 pixels a run — not rasteriser noise,
which is one or two.

**And then the timestamp too.** With the badge fixed the inbox still moved, by
160 pixels: `last_message_at` had been derived from the window, so it moved with
it, and the inbox prints it absolutely. The window stays relative because
nothing renders it as an instant; the timestamps beside it are literals because
something does. **Which column gets which is decided by what renders it, not by
the table.**

### Both states are seeded

A verified workspace with nothing in it joins the busy one — deliberately not
the *unverified* workspace beside it, which renders the KYC gate on every page
and so never reaches a feature's own empty state. An empty dashboard is what
every tenant sees on their first day and the state least likely to be looked at
during development, because the machine it is built on always has data.

---

## What is not here

- **A tenant-facing export.** Every figure is already on the page, and a CSV of
  four numbers is a feature request nobody has made.
- **Date-range selection.** "Today" and "this month" are the two windows the
  rollup stores. A range picker means either recomputing on demand — the six
  scans this phase removed — or a rollup per range.
- **Anything about AI, orders or lead scores except an honest card.** Those
  columns do not exist, and a dashboard is the worst place to invent one.
- **Realtime.** The page states its age instead. A socket for figures that
  change every sixty seconds is a connection per open tab for no new fact.

---

## At the tag

- **Destructive policy audit re-run.** RLS disabled on all 25 tenant tables,
  `rls-isolation.test.ts` re-run: **52 failed, 5 passed** — exactly the five in
  the allowlist (the role-attribute guard, the fixture-sanity check, the two
  owner catalog facts, and the TRUNCATE grant). No sixth survivor. The eight
  passes in `database-roles.test.ts` are about grants and role attributes rather
  than policies, and are expected. RLS restored, then `db:nuke -- test` rebuilt
  the database from the migrations rather than from the restore — the migration
  is the only copy of that DDL worth trusting.
- **`npm run db:verify`** — all four invariants hold on **dev** and on **test**.
- **`npm run db:explain:dashboard`** — every windowed query is an index scan
  under RLS, and the `now()` comparison is recorded above.
- **Gate green**, with the known worker crash costing seven runs across two
  commits. See below.

### Carried forward

**The pre-commit hook cannot absorb the `ECONNRESET` presentation of the worker
crash.** Its retry requires that no test reported a failure — correctly, because
a real failure must never get a second roll of the dice. But the conventions
already record that an `ECONNRESET` on a named test *is* the worker dying and
taking its socket down, and in that presentation a test does report as failed.
This phase hit it twice. Widening the guard is a change to the commit gate and
belongs in its own diff, not in one that needed it to pass.

**Reclaiming the Docker WSL VM's page cache is the cheap first move** on that
crash, and is new:

```
wsl -d docker-desktop --exec sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"
```

It took `vmmemWSL` from 2803 MB to 1117 MB, and the very next gate run passed —
twice, on two separate occasions in this phase. Non-destructive: clean cache
only, no restart, nothing lost. Cheaper than the `.wslconfig` cap the
conventions describe, and worth trying first.

**The visual suite now depends on completing within the stale threshold.** The
busy fixture's rollup is stamped `now()`, and the page reads "Counted within the
last few minutes" for any age under five minutes. A run slower than that flips
the line to the stale wording and fails the baseline — legibly, but for the
machine rather than for the page.
