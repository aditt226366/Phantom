-- Authentication schema.
--
-- The table DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written: policies, grants and the two SECURITY DEFINER lookup functions.
--
-- Note the ADD COLUMN ... NOT NULL statements with no default. They fail on a
-- non-empty users table, which is correct: there has never been a signup flow,
-- so any existing row is a fixture, and inventing a placeholder password_hash
-- for a real account would be far worse than a migration that stops.

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('SIGNUP', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGED', 'EMAIL_VERIFIED', 'HIBP_UNAVAILABLE');

-- DropIndex
DROP INDEX "users_company_id_email_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "name",
ADD COLUMN     "email_verified_at" TIMESTAMP(3),
ADD COLUMN     "full_name" TEXT NOT NULL,
ADD COLUMN     "last_login_at" TIMESTAMP(3),
ADD COLUMN     "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "password_hash" TEXT NOT NULL,
ADD COLUMN     "phone_e164" TEXT NOT NULL,
ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'MEMBER',
ADD COLUMN     "username" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_secret" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" "audit_action" NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "lockout_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_secret" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT,
    "action" TEXT NOT NULL,
    "ip" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_company_id_user_id_idx" ON "sessions"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_company_id_user_id_idx" ON "email_verification_tokens"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_created_at_idx" ON "audit_log"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_attempts_locked_until_idx" ON "login_attempts"("locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "login_attempts_username_ip_key" ON "login_attempts"("username", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions"("admin_user_id");

-- CreateIndex
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tenant-owned tables: RLS, forced, one policy per role
-- ---------------------------------------------------------------------------

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_company_isolation ON "sessions"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY sessions_admin_access ON "sessions"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verification_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY evt_company_isolation ON "email_verification_tokens"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY evt_admin_access ON "email_verification_tokens"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_company_isolation ON "audit_log"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
CREATE POLICY audit_log_admin_access ON "audit_log"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Admin tables: app_runtime must not be able to read them at all
-- ---------------------------------------------------------------------------
--
-- These are global, so no RLS policy scopes them. Without an explicit revoke
-- they would inherit the default privileges granted to app_runtime, which
-- would let an ordinary tenant request read admin_users.password_hash. The
-- schema-invariants test asserts app_runtime holds nothing on these tables.

REVOKE ALL ON "admin_users", "admin_sessions", "admin_audit_log"
  FROM app_runtime;

-- ---------------------------------------------------------------------------
-- The pre-authentication lookup problem
-- ---------------------------------------------------------------------------
--
-- Sign-in is username + password with no company selector. So the username
-- lookup, the session-cookie lookup and the slug-collision check all have to
-- happen BEFORE any company context exists — which is exactly the situation
-- RLS is built to refuse.
--
-- The tempting fixes are both bad. Making users and sessions globally readable
-- to app_runtime hands away the entire guarantee. Adding an
-- `OR current_setting('app.bypass') = 'on'` escape hatch to the policies is the
-- same thing with extra steps, and turns a hard boundary into a soft one.
--
-- Instead: app_resolver holds SELECT-only policies on the three lookup tables
-- and owns the SECURITY DEFINER functions below. app_runtime is granted
-- EXECUTE, and nothing else. The total cross-company capability handed to the
-- application is "map one opaque key to one company id" — the functions return
-- a single text value and never a row.
--
-- app_resolver is NOLOGIN, so its privileges are unreachable except by calling
-- these functions. whatsapp_owner is a member of it only WITH INHERIT FALSE,
-- so the owner does not pick up these policies and keeps seeing nothing — see
-- the FORCE ROW LEVEL SECURITY test.
--
-- The one rule at the call site: the value returned here may be passed to
-- withCompany. A company id taken from a request parameter may never be.

-- A policy is not a privilege. RLS narrows what a role may see *within* the
-- rows a GRANT already lets it read; with no GRANT at all, the policy never
-- gets a chance to apply and the query fails with "permission denied for
-- table". Both halves are required, and only SELECT is given.
GRANT SELECT ON "users", "sessions", "email_verification_tokens", "companies"
  TO app_resolver;

CREATE POLICY users_resolver_read ON "users"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);
CREATE POLICY sessions_resolver_read ON "sessions"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);
CREATE POLICY evt_resolver_read ON "email_verification_tokens"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);
CREATE POLICY companies_resolver_read ON "companies"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);

CREATE FUNCTION app_resolve_company(kind text, key text) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  result text;
BEGIN
  IF kind = 'username' THEN
    SELECT company_id INTO result FROM users WHERE username = key;

  ELSIF kind = 'session' THEN
    SELECT company_id INTO result FROM sessions
     WHERE token_hash = key AND revoked_at IS NULL AND expires_at > now();

  ELSIF kind = 'verification' THEN
    SELECT company_id INTO result FROM email_verification_tokens
     WHERE token_hash = key AND consumed_at IS NULL AND expires_at > now();

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- Slug allocation
-- ---------------------------------------------------------------------------
--
-- Two companies may legitimately be called the same thing, so a slug collision
-- must never surface as "that company name is taken" — the name is not taken,
-- and saying so leaks the existence of another tenant. A short suffix is
-- appended instead.
--
-- This needs SECURITY DEFINER for the same reason as above: inside
-- withCompany, the companies table shows exactly one row, so a collision check
-- from there would always report the slug as free and the INSERT would then
-- fail on the unique constraint.
--
-- The result is still only free as of this instant. A concurrent signup taking
-- the same slug in between raises a unique violation, which the caller retries.
-- Bounded, so a pathological base cannot spin.

CREATE FUNCTION app_available_slug(base text, attempts int DEFAULT 12) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate text;
  suffix    text;
BEGIN
  IF base IS NULL OR base = '' THEN
    base := 'company';
  END IF;

  candidate := base;

  FOR i IN 0..attempts LOOP
    IF NOT EXISTS (SELECT 1 FROM companies WHERE slug = candidate) THEN
      RETURN candidate;
    END IF;

    -- Widen the alphabet as attempts grow, so late retries collide less.
    suffix := substr(md5(random()::text || clock_timestamp()::text), 1, 4 + (i / 4));
    candidate := base || '-' || suffix;
  END LOOP;

  RAISE EXCEPTION 'could not allocate a slug for % after % attempts', base, attempts;
END $$;

ALTER FUNCTION app_resolve_company(text, text) OWNER TO app_resolver;
ALTER FUNCTION app_available_slug(text, int)   OWNER TO app_resolver;

REVOKE ALL ON FUNCTION app_resolve_company(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_available_slug(text, int)   FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_resolve_company(text, text) TO app_runtime, app_admin;
GRANT EXECUTE ON FUNCTION app_available_slug(text, int)   TO app_runtime, app_admin;
