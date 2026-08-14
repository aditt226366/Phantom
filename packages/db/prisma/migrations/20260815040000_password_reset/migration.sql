-- Password reset tokens.
--
-- The table DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written: policies, grants, and the resolver kind that lets an
-- unauthenticated request find the company a token belongs to.

-- AlterEnum
ALTER TYPE "audit_action" ADD VALUE 'PASSWORD_RESET_REQUESTED';

-- AlterEnum
ALTER TYPE "login_scope" ADD VALUE 'PASSWORD_RESET';

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_company_id_user_id_idx" ON "password_reset_tokens"("company_id", "user_id");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================

ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY password_reset_company_isolation ON "password_reset_tokens"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

CREATE POLICY password_reset_admin_access ON "password_reset_tokens"
  AS PERMISSIVE FOR ALL TO app_admin USING (true) WITH CHECK (true);

-- A policy is not a privilege: the resolver needs both.
GRANT SELECT ON "password_reset_tokens" TO app_resolver;

CREATE POLICY password_reset_resolver_read ON "password_reset_tokens"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);

-- ---------------------------------------------------------------------------
-- Resolving a reset token to a company
-- ---------------------------------------------------------------------------
--
-- Consuming a reset link is unauthenticated by definition — that is the point
-- of the link — so the company has to be found from the token itself, exactly
-- as for session and verification lookups. One text value out, never a row.
--
-- SET ROLE is required: app_resolve_company is owned by app_resolver, and
-- CREATE OR REPLACE requires being the owner. whatsapp_owner is a member only
-- WITH INHERIT FALSE, deliberately, so that it does not pick up app_resolver's
-- SELECT policies and quietly break the "owner sees nothing" proof of FORCE ROW
-- LEVEL SECURITY. Session-scoped, not SET LOCAL: Prisma does not guarantee this
-- file runs inside one transaction, and SET LOCAL outside one is a silent no-op.

SET ROLE app_resolver;

CREATE OR REPLACE FUNCTION app_resolve_company(kind text, key text) RETURNS text
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

  ELSIF kind = 'email' THEN
    SELECT company_id INTO result FROM users WHERE email = key;

  ELSIF kind = 'session' THEN
    SELECT company_id INTO result FROM sessions
     WHERE token_hash = key AND revoked_at IS NULL AND expires_at > now();

  ELSIF kind = 'verification' THEN
    SELECT company_id INTO result FROM email_verification_tokens
     WHERE token_hash = key AND consumed_at IS NULL AND expires_at > now();

  ELSIF kind = 'password_reset' THEN
    SELECT company_id INTO result FROM password_reset_tokens
     WHERE token_hash = key AND consumed_at IS NULL AND expires_at > now();

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

RESET ROLE;
