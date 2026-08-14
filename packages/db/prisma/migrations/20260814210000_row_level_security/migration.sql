-- Row-level security.
--
-- This is the commit the multi-tenancy story rests on. Everything above this
-- layer — the withCompany extension, code review, discipline — is advisory.
-- These policies are not: they are enforced by Postgres on every statement,
-- including raw SQL, including statements the application layer never saw.

-- ---------------------------------------------------------------------------
-- The current company, as the policies see it
-- ---------------------------------------------------------------------------
--
-- Two subtleties are wrapped up in this one function, and both fail silently
-- if you get them wrong:
--
-- 1. current_setting('app.company_id') RAISES if the setting was never set.
--    The second argument (missing_ok) makes it return NULL instead. A policy
--    that errors instead of denying is a broken policy.
--
-- 2. Once a transaction has set the GUC, the placeholder persists on that
--    pooled connection and resets to the EMPTY STRING — not NULL — when the
--    transaction ends. So "never set" and "set then reset" are two different
--    values, and only NULLIF collapses them into one.
--
-- With both handled, an unset context yields NULL, and `company_id = NULL` is
-- NULL, which a policy treats as false. Reads return zero rows; writes raise.
-- It fails closed in both directions.
CREATE OR REPLACE FUNCTION app_current_company() RETURNS text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.company_id', true), '') $$;

REVOKE ALL ON FUNCTION app_current_company() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_company() TO app_runtime, app_admin;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
--
-- The tenant key here is `id`, not `company_id` — a company is its own tenant.
--
-- Note what WITH CHECK implies for signup: a company row cannot be inserted
-- unless the GUC already holds the id being inserted. So the id must be
-- generated in application code before the transaction opens, which is why
-- packages/db depends on cuid2 rather than leaving it to @default(cuid()).
--
-- The tempting alternative — WITH CHECK (true) so any insert is allowed — does
-- not work with Prisma. Every create() emits INSERT ... RETURNING, and Postgres
-- requires a permitting SELECT policy for the RETURNING clause. Generating the
-- id up front removes the whole problem.
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_company_isolation ON "companies"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (id = app_current_company())
  WITH CHECK (id = app_current_company());

CREATE POLICY companies_admin_access ON "companies"
  AS PERMISSIVE FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY users_company_isolation ON "users"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY users_admin_access ON "users"
  AS PERMISSIVE FOR ALL TO app_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Why FORCE, and what it costs
-- ---------------------------------------------------------------------------
--
-- ENABLE alone leaves the table OWNER exempt. FORCE removes that exemption.
--
-- It matters because the startup check in client.ts can only see role
-- attributes: it rejects a superuser or BYPASSRLS connection, but a plain
-- non-owner-looking role that happens to OWN the tables passes every attribute
-- test while being completely exempt. That is the normal shape of a managed
-- Postgres migration user. FORCE is what closes that hole. (client.ts also
-- checks table ownership for the same reason — belt and braces.)
--
-- The cost is real and lands on whoever writes the first data-backfill
-- migration. The owner is now subject to these policies too, so a bare UPDATE
-- in a migration matches no policy and touches no rows. The pattern is:
--
--     ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
--     UPDATE "users" SET ...;
--     ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--
-- Explicit, greppable, and visible in review.
--
-- Be aware this does NOT reproduce locally: the dev `whatsapp` role is the
-- container's superuser, and superusers bypass RLS regardless of FORCE. So the
-- backfill dance above will first be exercised in an environment where the
-- owner is not a superuser. Do not discover that during a deploy.
