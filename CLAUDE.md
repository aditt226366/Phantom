# whatsapp-os

Next.js 16 App Router monorepo + BullMQ worker + multi-tenant Prisma layer.
`README.md` is the long-form guide; this file is the set of rules that hold
regardless of what you are working on.

---

## Project rules — always true

These are not suggestions and they are not up for renegotiation inside a task.
If a request appears to require breaking one, stop and say so rather than
quietly working around it.

### 1. Tenant isolation is a schema-level guarantee

Every tenant-owned table has:

- a `company_id` column, `NOT NULL`;
- a composite index **leading with `company_id`**;
- a Postgres row-level security policy, defined in a migration.

A model without all three is not finished, no matter what the application layer
does on top of it. A table opts out only by being named in `GLOBAL_TABLES` in
`packages/db/tests/schema-invariants.test.ts`, with a comment saying why —
which makes opting out a visible diff in a security-relevant file.

A policy is not a privilege: RLS narrows what a role sees *within* rows a
`GRANT` already permits. Both are needed, and both are asserted.

### 2. Route handlers never touch the raw Prisma client

Only `withCompany`. Importing `prisma` directly inside `app/api/**` is a bug.

```ts
import { withCompany } from "@whatsapp-os/db";

await withCompany(session.companyId, async (db, companyId) => {
  return db.user.findMany();
});
```

Never pass a company id that came from the request. `withCompany` sets the
value RLS trusts, so `withCompany(searchParams.companyId, …)` is a complete
bypass. Company ids may originate in exactly two places: the session row, and
`resolveCompany()`.

`resolveCompany(kind, key)` is the pre-authentication lookup — sign-in is
username-only, so the username and session-cookie lookups happen before any
company context exists. It calls a `SECURITY DEFINER` function owned by
`app_resolver` and returns a company id and nothing else, never a row.
`packages/db/src/resolve-company.ts` and `company.ts` are the only sanctioned
raw-SQL sites in the codebase.

Keep HTTP calls and password hashing *outside* the callback — it holds a pooled
connection and times out after 5s.

### 3. The platform admin is a separate account space, not a permission

`/admin` has its own table (`admin_users`), its own session table, and its own
cookie. There is no role flag on a tenant session and there must never be one:
escalation would then be a matter of setting a boolean, rather than forging a
token in a table `app_runtime` holds no grants on at all.

`app_resolve_company` cannot reach admin sessions — it only knows about rows
that carry a `company_id`.

> **Admin TOTP is deferred to Phase 12, deliberately.** A password alone on a
> panel that reads across every tenant is a known gap, not an oversight. It is
> written down here so nobody has to decide whether it was forgotten.

### 4. Cross-tenant access returns 404, never 403

A 403 confirms the row exists. If it is not yours, it does not exist.

### 5. No literal hex outside `globals.css`

Every colour, type, radius and spacing value comes from a `--wa-*` token.
`apps/web/tailwind.config.ts` maps utility names onto those properties and
contains no literal values at all.

Sole existing exception: `viewport.themeColor` in `apps/web/app/layout.tsx`,
which is emitted as a `<meta>` tag and cannot take a CSS custom property.

### 6. Display face is EB Garamond at weight 400

Google Fonts' EB Garamond `wght` axis starts at **400** — `wght@300` returns
HTTP 400. The design doc's 300 is unavailable.

**Never bold display copy, and do not "fix" the 400 to 300.** This has been
checked; a PR that changes it is reverting a known-correct decision. If a
literal 300 is ever genuinely required, the fix is to swap the face to
Cormorant Garamond, not to edit the weight number.

See `.claude/skills/elevenlabs-design/SKILL.md` for the full design system —
it loads automatically on any UI work.

---

## Current state vs. the rules

Rule 1 holds and is enforced by `packages/db/tests/schema-invariants.test.ts`,
which reads the live catalog: a new table without `company_id`, a composite
index leading with it, RLS enabled *and* forced, policies for both roles, and
CRUD-but-not-TRUNCATE grants will fail the suite. Opting a table out means
naming it in a constant in that file.

Rule 4 is enforced by the verify-email path: a token belonging to another
company resolves to nothing and returns 404, with a test.

`apps/web/lib/admin-db.ts` is the only module permitted to import
`@whatsapp-os/db/admin`. It exposes named queries and never the client itself.

---

## Layout

```
apps/
  web/          Next.js 16 App Router, Tailwind, shadcn/ui
  worker/       BullMQ consumers, plain Node via tsx
packages/
  db/           Prisma schema, generated client, withCompany extension
  core/         Shared types, Zod schemas, env contract, encryption helper
```

`packages/*` are consumed as TypeScript source with **no build step** — Next
transpiles them and the worker runs them through `tsx`. Import with explicit
`.ts` extensions.

## Commands

Run from the repo root.

| Command | Does |
| --- | --- |
| `npm run dev` | Web on :3000 |
| `npm run dev:worker` | Worker |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint on the web app |
| `npm run db:migrate` | `prisma migrate dev` (prompts for the name — `-- --name` does not work) |
| `npm run services:up` / `:down` | Postgres + Redis |

`/styleguide` renders every token and component variant by parsing
`globals.css` at build time. If a token change does not show up there, it did
not land.
