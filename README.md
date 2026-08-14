# whatsapp-os

Foundation scaffold: a Next.js 16 App Router monorepo with a background worker,
a multi-tenant Prisma layer, and a design-token system translated from
`DESIGN-elevenlabs.md`.

**No product features yet.** Everything here is plumbing, tokens, and the
`/styleguide` route that documents them.

---

## Local setup

Six commands. Requires Node ≥ 20.9 and Docker.

```bash
cp .env.example .env         # 1. then set ENCRYPTION_KEY (see below)
npm install                  # 2. installs every workspace
docker compose up -d         # 3. Postgres + Redis
npm run db:setup             # 4. migrations, database roles, Prisma client
npm run dev                  # 5. web on http://localhost:3000
npm run dev:worker           # 6. worker (second terminal)
```

`db:setup` is three steps: it applies migrations as the owner, then runs
`npm run db:roles` to give `app_runtime` and `app_admin` a login, then
generates the client. `db:roles` is idempotent — re-run it any time the roles
go missing, including against a database that already has data.

Generate a real encryption key for step 1:

```bash
openssl rand -base64 32
```

**Port already in use?**

- Postgres / Redis: set `POSTGRES_PORT` / `REDIS_PORT` in `.env` to something
  free, and update `DATABASE_URL` / `REDIS_URL` to match.
- Web: `PORT` is read by Next from the shell, not `.env` — the server binds
  before `.env` is loaded. Use `PORT=3001 npm run dev`.

> `db:setup` applies the committed migration in
> `packages/db/prisma/migrations/` and is non-interactive. Use
> `npm run db:migrate` when you change `schema.prisma` and want a *new*
> migration — Prisma will prompt for its name.
>
> Note that `npm run db:migrate -- --name foo` does **not** work: npm consumes
> `--name` as its own flag before Prisma sees it. Let it prompt, or run
> `npx prisma migrate dev --name foo` from `packages/db`.

Then check everything is talking to everything:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"db":true,"redis":true}
```

| Route | What it is |
| --- | --- |
| `/` | Placeholder landing page |
| `/styleguide` | Every design token and component variant |
| `/api/health` | `{ ok, db, redis }` — 200 when healthy, 503 when not |

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

`packages/*` are consumed as **TypeScript source with no build step** — Next
transpiles them (`transpilePackages`) and the worker runs them through `tsx`.
That removes a whole build-order problem from the monorepo, at the cost of
importing with explicit `.ts` extensions, which is also what the Prisma
generator emits.

### Scripts

Run from the repo root:

| Command | Does |
| --- | --- |
| `npm run dev` | Web app on :3000 |
| `npm run dev:worker` | Worker, watching for changes |
| `npm run build` | Production build of the web app |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint on the web app |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:studio` | Prisma Studio |
| `npm run services:up` / `:down` | Postgres + Redis |

---

## Design tokens

Translated from `DESIGN-elevenlabs.md`. Two files, one direction of dependency:

- **`apps/web/app/globals.css`** — the single source of truth. Every colour,
  type step, radius and spacing value is a CSS custom property (`--wa-*`).
- **`apps/web/tailwind.config.ts`** — maps Tailwind utility names onto those
  properties. It contains **no literal values at all**; changing a brand value
  means editing one line in one file.

`/styleguide` parses `globals.css` at build time rather than restating the
values, so it documents what the system actually is and cannot drift.

### The rules this system is built around

- Canvas `#f5f5f5`, cards `#ffffff`, ink `#0c0a09`, primary CTA fill `#292524`,
  hairline `#e7e5e4`.
- **No saturated brand action colour.** The near-black ink pill is the only
  filled CTA. Green appears once, as `--wa-success`, and is never clickable.
- **Display never bolds.** EB Garamond carries display copy at the light weight.
- Body is Inter 400/500 with ~+0.15px tracking.
- Primary CTA: ink pill, `9999px` radius, 40px tall.
- **Gradient orbs are decoration only** — never a surface, never a button fill,
  never a text colour. The `GradientOrb` component enforces this by
  construction: it accepts no children, is `aria-hidden`, and has
  `pointer-events: none`.

### One deviation from the source document, on purpose

The design doc specifies **Waldenburg Light at weight 300** and names **EB
Garamond** as the open-source substitute. Google Fonts ships EB Garamond on a
**400–800 axis — there is no 300 cut** (`wght@300` returns HTTP 400).

So `--wa-display-weight` is set to **400**, the lightest weight EB Garamond
actually has. The "never bold" rule is unaffected. If you want a literal 300,
swap the display face to **Cormorant Garamond**, which does ship one:

```diff
- import { EB_Garamond, Inter } from "next/font/google";
+ import { Cormorant_Garamond, Inter } from "next/font/google";
```

…then set `--wa-display-weight: 300` in `globals.css`. Nothing else changes.

---

## Database roles

There are three connection strings, and which role each uses is load-bearing:

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_URL` | owner | migrations and the Prisma CLI, nothing else |
| `DATABASE_URL_APP` | `app_runtime` | every application query |
| `DATABASE_URL_ADMIN` | `app_admin` | the `/admin` route group only |

**Postgres exempts a table's owner from that table's row-level security
policies.** An application connected as the owner would pass straight through
every policy, and the isolation tests would go green while enforcing nothing.
So the app has its own non-owner role, and `packages/db/src/client.ts`
deliberately does *not* fall back to `DATABASE_URL` when `DATABASE_URL_APP` is
missing — it throws, and explains why.

`assertRuntimeRoleIsUnprivileged()` is one query that refuses to proceed if the
runtime connection turns out to be a superuser or `BYPASSRLS`. It costs
nothing and it makes the single worst misconfiguration in this system
impossible to ship quietly.

Role *identity* is created by a migration, with no password, so it is committed
and works in production. The *credential* comes from `npm run db:roles`, which
refuses to run with `NODE_ENV=production` — set those passwords from your
secrets manager instead:

```sql
ALTER ROLE app_runtime LOGIN PASSWORD '...';
ALTER ROLE app_admin   LOGIN PASSWORD '...';
```

> **`prisma db push` is gone on purpose.** It writes the schema directly and
> skips migration SQL, which is where the roles, grants and RLS policies live.
> It would produce a database that looks correct and enforces nothing.

---

## Multi-tenancy

`withCompany(companyId)` returns a Prisma client that is incapable of touching
another company's rows:

```ts
import { withCompany } from "@whatsapp-os/db";

const db = withCompany(session.companyId);
await db.user.findMany();              // WHERE company_id = $1, always
await db.user.create({ data: { … } }); // company_id injected
```

Reads, updates and deletes get `companyId` merged into `where`; creates get it
merged into `data`.

**Three limits worth knowing before you rely on it:**

1. **Raw queries are not scoped.** `$queryRaw` / `$executeRaw` bypass the model
   query hook entirely. Filter by `company_id` by hand.
2. **Nested writes are not scoped.** Only the top-level record gets `companyId`.
3. **Models must be registered.** Adding a company-scoped model to
   `schema.prisma` means adding it to `COMPANY_SCOPED_MODELS` in
   `packages/db/src/with-company.ts`.

This is an application-layer guard. For a hard guarantee, add Postgres
row-level security underneath it — which is what the rest of Phase 1 does, at
which point this signature changes to a callback form that opens a transaction
and sets `app.company_id` for the policies to read.

> **Prisma 7 note:** the datasource URL lives in `packages/db/prisma.config.ts`,
> not in `schema.prisma`, and the client connects through the `@prisma/adapter-pg`
> driver adapter rather than a bundled query engine.

---

## Encryption

`packages/core/src/encryption.ts` — AES-256-GCM, 96-bit random IV per message,
authenticated. Wire format is versioned so the key or algorithm can be rotated
without a destructive migration:

```
v1.<iv>.<tag>.<ciphertext>
```

```ts
import { encrypt, decrypt } from "@whatsapp-os/core";

const sealed = encrypt("secret", process.env.ENCRYPTION_KEY);
const plain  = decrypt(sealed,  process.env.ENCRYPTION_KEY);
```

Not for passwords — hash those with argon2/bcrypt. There is no legitimate
reason to read a password back.

---

## Queues

Job payload schemas live in `packages/core/src/queues.ts` and are imported by
both sides, so the producer cannot enqueue a shape the consumer can't parse.
The worker **re-validates every payload it receives** — a job may have been
enqueued by an older deploy.

The scaffold ships one job, `system.ping`, purely to prove the
enqueue → consume → database path. Delete it when you add a real one.

### Worker container

Build from the **repository root** — the worker depends on `packages/*`:

```bash
docker build -f apps/worker/Dockerfile -t whatsapp-os-worker .
```

Or through compose:

```bash
docker compose --profile worker up -d --build
```

The image runs TypeScript directly through `tsx` (no compile step), runs as the
unprivileged `node` user, and uses `tini` so `docker stop` triggers the
worker's graceful-shutdown handler instead of killing in-flight jobs.

Two things in that Dockerfile look odd and are load-bearing:

- **It rewrites the workspace list before installing.** `npm ci --workspace=worker`
  does *not* prune — npm reproduces the whole lockfile, dragging Next.js and
  React into a worker image that never renders a page. Narrowing
  `workspaces` first is what actually scopes the install (748MB → 255MB of
  `node_modules`).
- **The `rm -rf` comes after the last npm command.** `npm prune` runs a reify
  pass that repairs the tree against the lockfile, so anything deleted before
  a subsequent npm call comes straight back.

---

## Environment

Every variable is documented in `.env.example` and validated at boot by the Zod
schemas in `packages/core/src/env.ts`. A missing or malformed value stops the
process with a readable report rather than surfacing as `undefined` three
layers deep.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | — | `development` \| `test` \| `production` |
| `DATABASE_URL` | yes | Must be `postgres://` or `postgresql://` |
| `REDIS_URL` | yes | Must be `redis://` or `rediss://` |
| `ENCRYPTION_KEY` | yes | base64, must decode to exactly 32 bytes |
| `QUEUE_PREFIX` | — | Defaults to `whatsapp-os` |
| `APP_URL` | — | Defaults to `http://localhost:3000` |
| `WORKER_CONCURRENCY` | — | Defaults to `5` |
| `LOG_LEVEL` | — | Defaults to `info` |

---

## Adding shadcn/ui components

`components.json` is configured, so the CLI works as normal:

```bash
npx shadcn@latest add dialog --cwd apps/web
```

Anything it generates will need its default palette classes swapped for the
`--wa-*` tokens — the components in `apps/web/components/ui/` are the
reference for how that looks.
