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
bypass. Company ids originate in exactly two places: the session row, and
`resolveCompany()`.

The only sanctioned raw-SQL sites are `packages/db/src/resolve-company.ts`,
`packages/db/src/company.ts` and `packages/db/src/vault.ts` — the last because
`SELECT … FOR UPDATE` has no query-builder form, and re-encrypting a credential
without holding its row loses a concurrent save irrecoverably. The unscoped client is confined to
`lib/auth/lockout.ts` and the admin client to `lib/admin-db.ts`, enforced by
both a lint rule and `apps/web/tests/server/no-raw-prisma.test.ts`.

### 4. Layouts are UX; server functions are authorization

A layout is cached per segment and is not guaranteed to re-execute on every
navigation within it. `requireSession()` there is a redirect for the user's
benefit. Every page, loader and server action calls it itself — React `cache()`
makes the repeats free.

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
| `npm run typecheck` / `lint` / `build` | The usual |
| `npm run admin:hash` / `admin:seed` | Platform admin credential |
