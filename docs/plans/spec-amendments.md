# Spec amendments

Decisions taken after the original phase plan was written, recorded here because
three of them change what a phase *is* rather than how it is built, and two of
them change the order phases ship in.

Written down before the affected phases start, so that the code which depends on
them — schema shapes, sequencing, what blocks what — is not re-derived from a
conversation nobody can find.

Status: **A4 is done** — Phase 3 shipped and is tagged; see `phase-3.md`. A6 is
in force and was run against dev and test at that tag. A1, A2, A3 and A5 have
not started. Phases 4a and 4b are complete; see `phase-4.md`.

---

## A1. Template Messaging is a rule-based flow builder, with no AI in it

**Changes: Template Messaging. Its own phase now, sequenced before the AI
layer.**

Users build decision trees out of WhatsApp's interactive messages. No model is
involved at any point: every branch is a rule somebody drew, and the same input
always produces the same next node. That is the entire product — a flow that
cannot surprise its author is the thing being sold, and it is also what makes it
answerable to A5's policy line without an argument.

Two message types carry it, and their limits are Meta's rather than ours:

| | |
| --- | --- |
| **Reply buttons** | Maximum **3** per message, **20 characters** each, each carrying an id we choose |
| **List messages** | Up to **10 rows**, grouped in sections |

### The window is the whole design constraint

Interactive messages need **no Meta approval**, which is what makes a visual
builder possible at all — a flow can be edited and re-published in seconds. They
also only work **inside the 24-hour customer service window**.

So an **approved template with quick-reply buttons is the only legal entry
point**, and the only way to resume a flow whose window has lapsed. A flow
therefore has exactly two kinds of step: the template that can start or restart
it, and the interactive messages that can only continue it.

### A button id encodes the run and the node, never just the choice

WhatsApp buttons **never expire in the chat**. The customer scrolls up three days
and taps "Yes" on a message from a flow that finished on Tuesday, and the payload
that arrives is whatever id we put there.

An id meaning "yes" is therefore ambiguous by construction: it cannot say which
question it answered, which run of the flow it belonged to, or whether that run
is still live. Encoding the flow run and the node makes a stale tap
*recognisable* — it resolves to a node the run has already left, or to a run that
has ended, and the engine can decline it deliberately instead of advancing a
different conversation on the strength of a three-day-old tap.

This has to be decided before the first button is sent, because the ids are in
customers' chat histories for ever and there is no migration for them.

### A flow whose window closes mid-run pauses; it does not fail

The customer stops replying for a day and the window shuts with the run halfway
down the tree. That is the ordinary case, not an error: nothing has gone wrong,
the flow simply cannot speak until spoken to.

So the run is **paused** — its position kept, resumable by the template entry
point above — rather than failed and discarded. A failed run would lose the
customer's answers, and the operator would see an error for something that is
merely waiting.

### Size and sequence

This is a visual builder **plus** a runtime engine: a canvas, node types,
validation of a tree against Meta's limits, versioning of a published flow, run
state, and the button-routing above. That is comparable in size to the AI layer,
not a feature within another phase, and it **ships before the AI layer** — the
deterministic engine is the thing the AI layer would otherwise be asked to
improvise, and building it second would mean building it twice.

---

## A2. AI Messaging is unchanged

**Changes: nothing.** Recorded so that "the flow builder replaced it" is not
inferred from A1. The AI layer ships as originally specified, after the flow
builder, and A5 below is a compliance constraint on it rather than a change to
its scope.

---

## A3. Meta Ads runs on the tenant's own Meta account

**Changes: Meta Ads.**

Each client connects **their own** Meta account, and their credentials are stored
per-tenant in the admin integrations section — exactly the model already in
production for the WhatsApp app secret and verify token. Nothing is shared, and
our app never holds a credential that reaches across tenants.

### What this removes

Our app no longer needs **Advanced Access** or **App Review** for
`ads_management`. That is a **2–4 week Meta dependency deleted from the critical
path**, and it was a dependency with no fallback: the review either passes or the
phase does not ship.

### What it costs, and what that obliges us to build

The setup moves to the tenant, who now does their own Meta-side work to produce a
token. That makes token lifetime a tenant-visible operational fact rather than
our internal detail, so two things become required rather than nice:

- **Expiry tracking in the vault.** A stored token needs its expiry recorded and
  checked, because the failure mode otherwise is a campaign that silently stops
  working and an operator with no reason for it.
- **A re-connect prompt.** When a token is expiring or has expired, the
  integrations section has to say so and offer the reconnect, in the same place
  the badge already reports connection state.

Both are additions to the existing vault and integrations surfaces, not new
subsystems. Recorded now because the schema for stored secrets is the thing they
land in, and adding an expiry column later is a backfill on encrypted rows.

---

## A4. KYC is mandatory before any feature use

**Changes: Documents/KYC, which returns and lands before the feature phases.**

**Shipped, tagged `phase-3`.** What follows is the amendment as written; the
implementation and the decisions it forced are in `phase-3.md`. Two things are
worth pulling back here because they change what a later phase has to do:

- The gate is **one function**, `canUseFeatures` in `@whatsapp-os/core/kyc`,
  and `canSend` calls it rather than restating it. A feature phase adding a
  send path inherits the gate by using `canSend`.
- Coverage is **enforced, not reviewed**. `feature-gate-coverage.test.ts` walks
  `app/(app)` and fails on a page or action that consults neither entry point,
  so a section added in Phase 5 or 7 fails the gate until it is either gated or
  exempted with a reason. That is this amendment's "the one that gets missed is
  the one nobody notices", made mechanical.

The original plan gated *sending* on verification. It now gates **everything**.

What an unverified account can do, in full:

```
sign up · sign in · upload documents · see verification status
```

Everything else is blocked until a platform admin approves. Not a banner, not a
degraded mode — blocked.

The sequencing consequence is the important half: **the KYC phase lands before
the feature phases**, because a gate added afterwards has to be retrofitted onto
every entry point that already exists, and the one that gets missed is the one
nobody notices. Building it first means each feature phase is written against a
gate that is already there.

This pairs with the rule already in `CLAUDE.md` that authorization lives in
server functions rather than layouts: the KYC gate is subject to exactly the same
constraint, and a layout check would be a redirect for the user's benefit rather
than the boundary.

---

## A5. Meta's AI policy constrains the AI layer

**Changes: AI Messaging — as a compliance requirement, not a design change.**

Since **15 January 2026**, general-purpose LLM chatbots are **banned on the
WhatsApp Business Platform**. Task-specific business assistants remain allowed.

Verse is already designed as the second kind, so nothing in the product changes.
What changes is the status of two behaviours that were previously good manners:

- it **genuinely refuses off-topic questions**, rather than answering them with a
  disclaimer;
- it **answers honestly when asked whether it is a human**.

Both are now compliance requirements, and both are the sort of thing that gets
quietly relaxed by a prompt edit six months from now. They are therefore recorded
in `.claude/skills/whatsapp-os-conventions/SKILL.md`, under the decisions already
taken, where weakening one is a diff in a reviewed file rather than a change to a
string.

---

## A6. `db:verify` is a Phase 12 launch gate

**Adds to: Phase 12 (launch readiness).**

`npm run db:verify -- <dev|test|connection-url>` checks four catalog invariants
against whichever database it is pointed at — `COLUMN_GRANTS`,
`RESOLVER_TABLE_GRANTS`, `OUT_OF_BAND_DDL` and the timestamp check. It is
read-only: every statement is a `SELECT` against a system catalog, which is what
makes it safe to run against production.

**It runs against production before first customer traffic, and after every
deploy.**

### Why a launch gate and not just a test

These four assertions already existed and already passed on every run — against
the *test* database. The database that was wrong was **dev**, missing two column
grants for eight commits, and the first symptom was a route that worked in the
suite and returned 500 in a browser (C10). Nothing about the assertions was
test-specific. Only the connection was.

Production is the instance of that problem nobody can rebuild. A tenant-visible
grant that drifted between staging and production is invisible to the suite by
construction, and the failure it produces is a 500 on a path that works
everywhere else.

### It is not `prisma migrate diff`, and does not overlap it

`migrate diff` compares tables and columns. It cannot see **grants** — a column
grant is not even in `pg_class.relacl`, it lives in `pg_attribute.attacl` — and
it cannot see **CHECK constraints**, **column storage** or **triggers**, none of
which `schema.prisma` can express. It reported *"No difference detected"* over
the drifted database throughout.

Both run at launch. They answer different questions, and neither answers the
other's.

### The root cause it exists to catch

Amending a migration in place after a database has applied it. `migrate deploy`
never re-runs an applied migration, so that database keeps the original's
effects for ever, and the recorded checksums are the only trace. Recorded in the
conventions skill, with the rule: **any in-place amendment must be followed by
rebuilding every database that applied the original — dev included.** A
production database cannot be rebuilt, so there the only fix is a new additive
migration.

---

## Sequencing, after these amendments

Two hard orderings, each with its reason:

| Ordering | Because |
| --- | --- |
| ~~KYC **before** every feature phase~~ **done** | A gate retrofitted onto existing entry points is a gate with a hole in it |
| Flow builder **before** the AI layer | The deterministic engine is what the AI layer would otherwise improvise, and building it second builds it twice |

Exact phase numbers are not renumbered here. Three phases changed size and two
changed position, so the numbering needs one deliberate pass rather than an
edit per amendment — and every `Phase N` reference already in the schema
comments, the migrations and `PHASES.md` moves with it.
