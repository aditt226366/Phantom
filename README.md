# whatsapp-os

A Next.js 16 App Router monorepo with a background worker, a multi-tenant
Postgres layer enforced by row-level security, authentication, and a design
system translated from `DESIGN-elevenlabs.md`.

Phase 1 covers sign-up and sign-in, sessions, the application shell and a
platform admin. The product sections render designed empty states; the
messaging features themselves are Phase 2.

---

## Local setup

Six commands. Requires Node ≥ 20.9 and Docker.

```bash
cp .env.example .env         # 1. then set ENCRYPTION_KEY (see below)
npm install                  # 2. installs every workspace
docker compose up -d         # 3. Postgres + Redis
npm run db:setup             # 4. database roles, migrations, Prisma client
npm run dev                  # 5. web on http://localhost:3000
npm run dev:worker           # 6. worker (second terminal)
```

`db:setup` is three steps, in this order: `db:roles` provisions the roles and
transfers table ownership, then migrations run as the owner, then the client is
generated. Roles come first because the authentication migration needs
`app_resolver` to already hold CREATE on schema public. `db:roles` is idempotent — re-run it any time the roles
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
| `/sign-up`, `/sign-in` | Authentication |
| `/dashboard` and six more | The application shell |
| `/admin` | Platform admin, a separate account space |
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
| `npm run verify` | The gate: typecheck, lint, build, tests, screenshots |
| `npm run dev` | Web app on :3000 |
| `npm run dev:worker` | Worker, watching for changes |
| `npm run build` | Production build of the web app |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint on the web app |
| `npm test` | Vitest, five projects |
| `npm run test:visual` | Screenshots of every page, 1440 and 390 |
| `npm run test:visual:update` | Re-record the baselines — then look at them |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:studio` | Prisma Studio |
| `npm run services:up` / `:down` | Postgres + Redis |

`verify` runs in that order for a reason: two of the checks read the compiled
stylesheet and one drives a built server, so the build has to come before the
tests rather than after them.

The screenshot suite needs a browser once:

```bash
npx playwright install chromium
```

It runs `next start` on :3210 against `whatsapp_os_test`, seeds a fixed fixture
into it — same company, same timestamps, same counts every run — and diffs 50
full-page screenshots against `apps/web/tests/visual/__screenshots__`. The
baselines are per platform, because the same Chromium rasterises text
differently on Windows, macOS and Linux; a first run on a new platform reports
the snapshots as missing and writes them rather than passing quietly.

---

## Platform admin

`/admin` is a separate account space, not a role: its own table, its own session
table, its own cookie, and no flag on the tenant session that could escalate.

```bash
npm run admin:hash     # prompts, prints an Argon2id hash
# put it in .env as ADMIN_PASSWORD_HASH, SINGLE-QUOTED
npm run admin:seed
```

The single quotes matter. An Argon2 hash is full of `$`, and Docker Compose
reads the root `.env` to substitute into `docker-compose.yml`.

`apps/web/lib/admin-db.ts` is the only module permitted to import the
cross-company client, enforced by a lint rule and by
`apps/web/tests/server/no-raw-prisma.test.ts`. Both, because they fail
differently.

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

Four connection strings, and which role each uses is load-bearing:

| Variable | Role | Used by |
| --- | --- | --- |
| `POSTGRES_SUPERUSER_URL` | superuser | `npm run db:roles`, nothing else |
| `DATABASE_URL` | `whatsapp_owner` | migrations and the Prisma CLI |
| `DATABASE_URL_APP` | `app_runtime` | every application query |
| `DATABASE_URL_ADMIN` | `app_admin` | the `/admin` route group only |

**Postgres exempts a table's owner from that table's row-level security
policies** unless `FORCE` is set, and exempts **superusers unconditionally**,
`FORCE` or not. Both exemptions matter here:

- The application has its own non-owner role, and
  `packages/db/src/client.ts` deliberately does *not* fall back to
  `DATABASE_URL` when `DATABASE_URL_APP` is missing — it throws and explains
  why.
- The owner is a plain `NOSUPERUSER NOBYPASSRLS` role rather than the container
  superuser. That is what turns "the owner sees nothing without a company
  context" into something the suite can check: against a superuser owner the
  assertion would pass for the wrong reason and every `FORCE` clause would be
  decoration. `whatsapp_owner` needs `CREATEDB` because `prisma migrate dev`
  provisions a shadow database and the test harness creates `whatsapp_os_test`.

`app_admin` reads across companies through an explicit per-table policy, **not**
`BYPASSRLS`. That attribute requires a real superuser to grant, which RDS,
Supabase and Neon do not provide, so the role would simply be uncreatable in
production. Forgetting an admin policy on a new table is a fail-closed bug — the
panel goes blank rather than the tenant boundary going away.

> **Default privileges are keyed to the role that CREATES a table**, not to the
> schema. When ownership moved to `whatsapp_owner`, the old entries stopped
> applying and new tables would have been created with no grants at all —
> `permission denied` on a table that looks perfectly correct. The
> `owner_default_privileges` migration re-points them, and the grant assertions
> in `schema-invariants.test.ts` are what would catch it happening again.

`assertRuntimeRoleIsUnprivileged()` is one query that refuses to proceed if the
runtime connection turns out to be a superuser or `BYPASSRLS`. It costs
nothing and it makes the single worst misconfiguration in this system
impossible to ship quietly.

`npm run db:roles` provisions all three roles and transfers ownership of every
object in `public` to `whatsapp_owner`. It is idempotent, safe against a
database that already has data, and the only thing in the repo that uses the
superuser credential. It refuses to run with `NODE_ENV=production` — create the
roles there from your secrets manager with the same attributes:

```sql
CREATE ROLE whatsapp_owner NOSUPERUSER NOBYPASSRLS CREATEDB LOGIN PASSWORD '...';
CREATE ROLE app_runtime    NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '...';
CREATE ROLE app_admin      NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '...';
```

It deliberately transfers ownership object by object rather than with
`REASSIGN OWNED BY`: the container's `POSTGRES_USER` is this cluster's
*bootstrap* superuser, so it also owns the system catalogs, the template
databases and `postgres` itself.

> **`prisma db push` is gone on purpose.** It writes the schema directly and
> skips migration SQL, which is where the roles, grants and RLS policies live.
> It would produce a database that looks correct and enforces nothing.

---

## Multi-tenancy

`withCompany` runs a unit of work scoped to exactly one company:

```ts
import { withCompany } from "@whatsapp-os/db";

const users = await withCompany(session.companyId, async (db, companyId) => {
  await db.user.create({ data: { companyId, email } });
  return db.user.findMany();          // WHERE company_id = $1, always
});
```

It opens a transaction and sets `app.company_id` on that connection, so the RLS
policies scope **every** statement inside it — including raw SQL, including
anything the extension never sees. On top of that it still merges `companyId`
into `where` and `data`, as defence in depth.

**Why a callback and not `withCompany(id).user.findMany()`:** because `SET` on a
pooled connection outlives the query that set it. The next borrower — a
different request, a different tenant — would inherit the context. The setting
has to be transaction-local, which requires every statement to run on one
pinned connection. The callback shape is what makes that expressible; it is not
a stylistic choice.

Two things to keep in mind:

1. **Keep slow work outside the callback.** A transaction holds a pooled
   connection and Prisma times it out after 5s. HTTP calls and password hashing
   belong before it. The default timeout is left in place so violations fail
   loudly in development.
2. **Nesting is a compile error.** `CompanyClient` has no `$transaction`, so a
   service needing scoped access takes `db: CompanyClient` as a parameter
   rather than opening its own scope.

### Row-level security

Every tenant table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, with a
policy keyed on `app_current_company()`. That helper exists because
`current_setting` has two traps: it *raises* when the setting was never set
(hence `missing_ok`), and it resets to the **empty string**, not NULL, once a
transaction has set it (hence `NULLIF`). Handled, an unset context is NULL,
`company_id = NULL` is NULL, and a NULL policy reads as false — reads return
nothing, writes raise. It fails closed both ways.

`packages/db/tests/rls-isolation.test.ts` is the proof, and every test in it
bypasses `withCompany` on purpose. `schema-invariants.test.ts` is the one that
matters longer term: it reads the live catalog and fails if *any* new table
lacks `company_id`, an index leading with it, RLS, a policy, or the right
grants. Opting out means adding a name to a constant in that file — a visible
diff in a security-relevant place.

> **Prisma 7 note:** the datasource URL lives in `packages/db/prisma.config.ts`,
> not in `schema.prisma`, and the client connects through the `@prisma/adapter-pg`
> driver adapter rather than a bundled query engine.

---

## Encryption

`packages/core/src/encryption.ts` — AES-256-GCM, 96-bit random IV per message,
authenticated, with a keyring so a key can be rotated without a destructive
migration. The key id is on the wire, so a stored value says which key opens it
rather than being discovered by trying each one:

```
v2.<key-id>.<iv>.<tag>.<ciphertext>
```

```ts
import { createKeyring, encrypt, decrypt } from "@whatsapp-os/core";

const keyring = createKeyring(env.ENCRYPTION_KEYS, env.ENCRYPTION_KEY_ACTIVE);

const sealed = encrypt("secret", keyring);
const plain  = decrypt(sealed, keyring);
```

**Bind a value to where it lives.** GCM authenticates additional data, and the
credential vault passes the row's own coordinates, so a ciphertext copied out of
one company's row into another's fails to open instead of quietly working:

```ts
const aad = `${companyId}:${integrationId}:${key}`;

const sealed = encrypt(token, keyring, aad);
const plain  = decrypt(sealed, keyring, aad);   // wrong aad ⇒ EncryptionError
```

The AAD is derived at call time and never stored. The cost is that the values it
is derived from become immutable in practice: changing a company id, an
integration id or a credential's *name* means decrypt-and-re-encrypt, not an
`UPDATE`.

**Rotation.**

```
npm run vault:rotate -- --dry-run   # how many rows would move, nothing queued
npm run vault:rotate                # one job per company
npm run vault:status                # must exit 0 before dropping the old key
```

`vault:rotate` refuses to start if `ENCRYPTION_KEY_ACTIVE` names a key absent
from `ENCRYPTION_KEYS`. `vault:status` opens every stored credential and exits
non-zero if any fails — so the drop-the-old-key step is gated on an exit code
rather than on somebody reading counts correctly at the end of a long
afternoon. It never prints a plaintext; the assertion is that decrypt
succeeded.

`reseal()` re-encrypts under the active key and reads the result back before
returning it, holding the row's lock throughout — an AAD built differently on
the encrypt side than the decrypt side would otherwise write a value that
nothing can ever open, and an unlocked reseal would silently revert a
concurrent save.

`ENCRYPTION_KEY` is a **separate** variable and not part of the keyring: it is
the HMAC key behind `hashIp()`, so changing it invalidates stored `ip_hash`
values rather than anything decryptable.

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
| `ENCRYPTION_KEY` | yes | base64, exactly 32 bytes. HMAC key for `hashIp()`, not the vault |
| `ENCRYPTION_KEYS` | yes | the vault keyring: `id:base64key,…`, each key 32 bytes |
| `ENCRYPTION_KEY_ACTIVE` | yes | which id in `ENCRYPTION_KEYS` seals new writes |
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
