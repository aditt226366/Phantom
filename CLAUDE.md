# whatsapp-os

Next.js 16 App Router monorepo + BullMQ worker + multi-tenant Postgres.

This file is loaded on every turn, so it holds only rules that are always true.
Anything episodic — how the tooling behaves, what has already been decided and
why — lives in the skills below, which load on demand.

- `.claude/skills/whatsapp-os-conventions/SKILL.md` — migrations, tests, env,
  and the decisions already taken. Read it before touching any of those.
- `.claude/skills/elevenlabs-design/SKILL.md` — the design system. Loads
  automatically on UI work.

---

## Rules

### 1. Two database roles, and the app is never the owner

| Variable | Role | For |
| --- | --- | --- |
| `POSTGRES_SUPERUSER_URL` | superuser | `npm run db:roles`, nothing else |
| `DATABASE_URL` | `whatsapp_owner` | migrations and the Prisma CLI |
| `DATABASE_URL_APP` | `app_runtime` | every application query |
| `DATABASE_URL_ADMIN` | `app_admin` | the `/admin` panel only |

Postgres exempts a table's owner from its own RLS policies unless `FORCE` is
set, and exempts superusers unconditionally. `app_runtime` owns nothing, so
policies apply to it. Nothing falls back to `DATABASE_URL`.

### 2. Tenant isolation is a schema-level guarantee

Every tenant-owned table has `company_id NOT NULL`, a composite index leading
with it, and an RLS policy defined in a migration. A table opts out only by
being named in `GLOBAL_TABLES` in
`packages/db/tests/schema-invariants.test.ts`, with a reason — which makes
opting out a visible diff in a security test.

The *composite* half has its own narrower list in the same file,
`SINGLE_ROW_PER_COMPANY_TABLES`, for a table holding exactly one row per
company: the primary key is then the whole lookup, and a second index column
would describe a read nothing performs. It waives that clause and nothing else —
`company_id`, RLS, the policies and the grants are all still asserted.

### 3. Data access goes through `withCompany`

```ts
await withCompany(session.companyId, async (db, companyId) => {
  return db.user.findMany();
});
```

A callback, because the company context is transaction-local; nesting is a
compile error. Keep HTTP calls and password hashing outside it — it holds a
pooled connection and times out after 5s.

**Never pass a company id that came from the request.** `withCompany` sets the
value RLS trusts, so `withCompany(searchParams.companyId, …)` is a total
bypass. Company ids originate in exactly three places:

| Origin | Trusted because |
| --- | --- |
| the session row | the cookie was resolved against `sessions` |
| `resolveCompany()` | SECURITY DEFINER, and the only lookup with no scope |
| **a job payload** | the producer put it there, and the producer is one of the two above |

`resolveCompany()` has seven kinds as of Phase 6. The two webhook kinds disagree
about suspension deliberately: `webhook` resolves for a deactivated company
because Meta disables a subscription that keeps failing, and `lead_source`
refuses one because that request only ever causes us to *send*.

The third arrived with Phase 4a's worker and is the one worth being careful
about, because it is the only one that has been *serialised*. Every job carries
`companyId` and the worker opens `withCompany` with it, having never seen a
request — so the guarantee is entirely about who enqueued.

Two things hold it up. Only our own code writes to the queue: the webhook route
enqueues after `resolveCompany()`, and a server action after `requireSession()`,
so no company id reaches Redis without passing one of the first two rows first.
And `parseJobPayload` validates against a registered Zod schema before a handler
runs, so a malformed payload throws with the job name in it rather than opening
a scope on whatever the string happened to be.

What that does **not** survive is somebody with write access to Redis, who can
name any company they like. The queue is a trust boundary in the same sense the
database is: reachable only from inside, and everything downstream assumes so.
Anything that ever accepts a job from outside this system has to re-derive the
company id rather than read it.

Raw SQL is confined to nine files in `packages/db/src` — `client.ts`,
`with-company.ts`, `resolve-company.ts`, `company.ts`, `vault.ts`,
`media-store.ts`, `kyc.ts`, `conversations.ts` and `dashboard.ts` — each because
the statement it needs has no query-builder form. `SELECT … FOR UPDATE`, without which re-encrypting a
credential loses a concurrent save irrecoverably. `substring()` over `bytea`,
without which a chunked read materialises the whole file — twice, over two
tables that must not share rows, because generalising one site to take a table
name from its caller is a worse shape than two sites naming their own. `GREATEST`, without
which advancing a conversation becomes three statements with two gaps in them —
and two webhook deliveries for the same thread interleave in those gaps, leaving
the newest timestamp beside the older message's preview. One UPDATE evaluates
every guard against one locked tuple. `FILTER` and `jsonb_object_agg`, without
which the dashboard's refresh is nineteen round trips instead of one — nineteen
passes over `messages`, seeing nineteen different snapshots, under a single
`computed_at` none of them individually supports.

The list lives in `packages/db/tests/no-raw-sql.test.ts`, which fails in both
directions, so a tenth site is a diff in a security test rather than a line
here. The unscoped client is confined to `lib/auth/lockout.ts` and the admin client to
`lib/admin-db.ts`, enforced by both a lint rule and
`apps/web/tests/server/no-raw-prisma.test.ts`.

### 4. Layouts are UX; server functions are authorization

A layout is cached per segment and is not guaranteed to re-execute on every
navigation within it. `requireSession()` there is a redirect for the user's
benefit. Every page, loader and server action calls it itself — React `cache()`
makes the repeats free.

The same applies to the KYC gate, which is the second thing this rule now
covers. `getFeatureAccess()` / `assertFeatureAccess()` in
`lib/auth/feature-gate.ts` are called by every page and every action of every
feature section; the layout calls the first one only to render a banner.
Hiding a nav item is not a boundary — the URL still resolves and a server
action is reachable by its id.

`apps/web/tests/server/feature-gate-coverage.test.ts` walks `app/(app)` and
fails on a page or action that consults neither, so a section added later is a
failing test rather than a hole. What A4 permits while unverified is exactly:
sign in, sign out, Profile > Personal details, Profile > Documents and the
verify-email flow. Each is exempted there by name, with a reason.

### 5. The platform admin is a separate account space, not a permission

`/admin` has its own table, its own session table and its own cookie. There is
no role flag on a tenant session and there must never be one.

### 6. Cross-company access returns 404, never 403

A 403 confirms the row exists. If it is not yours, it does not exist.

### 7. No literal hex outside `globals.css`

Every colour, type, radius and spacing value comes from a `--wa-*` token.
Sole exception: `viewport.themeColor` in `app/layout.tsx`, which is a `<meta>`
tag and cannot take a CSS variable.

Display face is EB Garamond at **400** — Google Fonts has no 300 cut. Never
bold it, and do not "fix" it to 300.

---

## Layout

```
apps/web/       Next.js 16 App Router, Tailwind
apps/worker/    BullMQ consumers, plain Node via tsx
packages/db/    Prisma schema, withCompany, the admin client
packages/core/  Types, Zod schemas, env contract, auth primitives
```

`packages/*` are consumed as TypeScript source with no build step. Import with
explicit `.ts` extensions.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Web on :3000 |
| `npm run db:setup` | Roles, migrations, Prisma client |
| `npm run db:roles` | Provision roles and ownership (idempotent) |
| `npm run db:nuke -- dev\|test` | Rebuild that database from nothing. Target required |
| `npm test` | Every project |
| `npm run test:visual` | Screenshots of every page at 1440 and 390 |
| `npm run verify` | The gate: typecheck, lint, build, test, test:visual |
| `npm run typecheck` / `lint` / `build` | The usual |
| `npm run admin:hash` / `admin:seed` | Platform admin credential |
