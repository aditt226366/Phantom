# Phases

What each phase shipped, and what its gate actually proved. A phase is done
when its gate passes, not when its commits land.

---

## Phase 1 — authentication, RLS, shell, platform admin

15 commits. Sign-up and sign-in, server-side sessions, row-level security with
`withCompany`, the application shell, and the platform admin as a separate
account space.

**Gate:** 267 tests, typecheck, lint, build.

---

## Phase 2 — admin console and credential vault

16 commits. The console an operator uses, the vault that holds provider
credentials, and the usage record Billing will need.

### What shipped

| | |
| --- | --- |
| **Schema** | `integrations`, `integration_secrets`, `integration_verifications`, `usage_events`, `admin_repair_runs`; `plan` and `deactivated_at` on `companies` |
| **Encryption** | AES-256-GCM keyring, `v2.<key-id>.<iv>.<tag>.<ciphertext>`, AAD binding each ciphertext to `company:integration:key` |
| **Redaction** | `redactKeys` + `scrubValues`, wired into the worker logger, derived from the provider registry |
| **Providers** | Google Sheets (REST, no `googleapis`), WhatsApp Cloud, Meta Ads — injected `fetch`, 10s timeout, one Graph version constant |
| **Console** | Platform analytics, companies with search and filter, per-company workspace, integrations tab, verification logs |
| **Operations** | `vault:status`, `vault:rotate`, Repair Integration DB |

### Gate results

Run at the end of the phase, on 15 August 2026.

| Check | Result |
| --- | --- |
| `npm test` | **546 passed**, 42 files, 5 projects |
| `npm run typecheck` | clean, 4 workspaces |
| `npm run lint` | clean |
| `npm run build` | clean, 7 admin routes |
| Migration drift | `No difference detected` |
| Destructive policy audit | exactly the 5 allowlisted tests survive |
| `.env.example` contract | parses against shared, web and worker |
| Key rotation, executed | k1 → k2 → drop k1, `vault:status` exit 0 throughout |

### The destructive policy audit

Every policy dropped, `rls-isolation.test.ts` re-run. Everything outside the
allowlist must fail. Re-run at phase end rather than only when written, because
the tests that drifted during Phase 2 were all correct when committed — what
changed underneath them was `COMPANY_SCOPED_MODELS` gaining entries, which
silently converted ORM assertions into tests of the extension.

Survivors, all correct — none reads a tenant row:

```
is connected as a role that RLS applies to      role attributes
seeded two distinct companies                   fixture sanity
is not a superuser and does not bypass RLS      role attributes
owns these tables                               catalog
can still TRUNCATE, which is why app_runtime    a grant, and TRUNCATE
  must not                                      ignores RLS by design
```

`packages/db/tests/no-orm-in-isolation.test.ts` now enforces the same rule at
source level, so a sixth exception is a diff in a security test.

### The rotation, executed

A procedure that has never been run is not a procedure. Against the development
database, with a real credential:

1. `ENCRYPTION_KEY_ACTIVE=k2` with k2 **absent** — `vault:rotate` refused,
   naming the ids it did have, before enqueueing anything.
2. k2 added. `vault:rotate --dry-run` reported 2 rows across 1 company,
   enqueued nothing.
3. `vault:rotate` queued one job; the worker resealed 2 rows, 0 failed.
4. `vault:status` — all rows on k2, exit 0.
5. k1 removed from `ENCRYPTION_KEYS`. `vault:status` — still exit 0.
6. A verification against a stubbed provider confirmed the resealed credential
   decrypts *and* reaches the provider as a bearer token.

### Deferred, deliberately

- **Impersonation.** Needs time-boxing, a tenant-visible banner, its own audit
  action, and a way for the tenant to see it happened. A design pass, not a
  button.
- **Admin TOTP.** Phase 12. A password alone on a panel that reads across every
  tenant is a known gap.
- **Documents, Billing.** Stubs with honest copy. `usage_events` is already
  recording, so Billing starts with history rather than from zero.
- **Whole-table `app_resolver` grants** on `users`, `sessions` and the two token
  tables. `companies` was narrowed to three columns; the other four are listed
  in `RESOLVER_TABLE_GRANTS` so they are visible rather than forgotten.
