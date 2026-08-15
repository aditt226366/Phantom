-- Company plan, and deactivation.
--
-- The DDL below is Prisma's, unedited. Everything from "SECURITY" down is
-- hand-written: the deactivation clause that makes a suspended workspace
-- actually stop working.

-- CreateEnum
CREATE TYPE "plan" AS ENUM ('STARTER', 'PRO', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "deactivated_at" TIMESTAMP(3),
ADD COLUMN     "plan" "plan" NOT NULL DEFAULT 'STARTER';


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- Deactivation has to hold in two places that are easy to think of as one:
-- sign-in, and a session that was issued before the workspace was suspended.
-- Blocking only the first leaves every already-signed-in tab working until its
-- cookie happens to expire, which is not what "deactivated" means to the
-- operator who pressed the button.
--
-- Both go through app_resolve_company(), so both are one clause each rather
-- than a check in every route. A route added later cannot forget it, and there
-- is no ordering hazard where a new entry point ships before someone remembers
-- to guard it. The check in requireSession() is for the message the user sees;
-- this is the part that makes it true.
--
-- Extended to every kind deliberately, not just 'username' and 'session'. A
-- suspended workspace should not be verifiable or resettable into either: a
-- pending reset link is exactly the thing an attacker would reach for after an
-- account is suspended for compromise.
--
-- No new GRANT or policy is needed. app_resolver already holds SELECT on
-- companies and companies_resolver_read from 20260814230000_authentication_schema,
-- because app_available_slug() reads the same table.
--
-- SET ROLE is required: app_resolve_company is owned by app_resolver, and
-- CREATE OR REPLACE requires actually being the owner. whatsapp_owner is a
-- member only WITH INHERIT FALSE, deliberately, so that it does not pick up
-- app_resolver's SELECT policies and quietly break the "owner sees nothing"
-- proof of FORCE ROW LEVEL SECURITY. Session-scoped, not SET LOCAL: Prisma does
-- not guarantee this file runs inside one transaction, and SET LOCAL outside
-- one is a silent no-op.

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
    SELECT u.company_id INTO result
      FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.username = key AND c.deactivated_at IS NULL;

  ELSIF kind = 'email' THEN
    SELECT u.company_id INTO result
      FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.email = key AND c.deactivated_at IS NULL;

  ELSIF kind = 'session' THEN
    SELECT s.company_id INTO result
      FROM sessions s JOIN companies c ON c.id = s.company_id
     WHERE s.token_hash = key AND s.revoked_at IS NULL AND s.expires_at > now()
       AND c.deactivated_at IS NULL;

  ELSIF kind = 'verification' THEN
    SELECT t.company_id INTO result
      FROM email_verification_tokens t JOIN companies c ON c.id = t.company_id
     WHERE t.token_hash = key AND t.consumed_at IS NULL AND t.expires_at > now()
       AND c.deactivated_at IS NULL;

  ELSIF kind = 'password_reset' THEN
    SELECT t.company_id INTO result
      FROM password_reset_tokens t JOIN companies c ON c.id = t.company_id
     WHERE t.token_hash = key AND t.consumed_at IS NULL AND t.expires_at > now()
       AND c.deactivated_at IS NULL;

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

RESET ROLE;
