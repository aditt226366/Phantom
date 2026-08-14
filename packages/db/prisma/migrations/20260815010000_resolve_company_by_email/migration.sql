-- Add an 'email' lookup to app_resolve_company.
--
-- Two reasons, one immediate and one already written into the schema.
--
-- Immediate: Prisma reports P2002 with no constraint name when it runs through
-- a driver adapter — the message is literally "Unique constraint failed on the
-- (not available)". So a signup that violates users_username_key and one that
-- violates users_email_key are indistinguishable from the error alone, and
-- there is no way to tell the user which field to fix. Signup checks both
-- before opening its transaction instead, and username already had a lookup.
--
-- Already written into the schema: User.email is globally unique precisely so
-- password reset can be keyed on it with no company context. That flow needs
-- exactly this lookup.
--
-- CREATE OR REPLACE preserves the owner (app_resolver) and the SECURITY DEFINER
-- marking, so the narrow-capability arrangement is unchanged: still one company
-- id out, never a row.
--
-- SET LOCAL ROLE is required and is the price of the WITH INHERIT FALSE grant.
-- whatsapp_owner is a member of app_resolver but does not inherit it — that is
-- deliberate, because inheriting would give the owner app_resolver's SELECT
-- policies and quietly break the "owner sees nothing" proof of FORCE ROW LEVEL
-- SECURITY. Membership still permits SET ROLE, and CREATE OR REPLACE requires
-- actually being the owner, so the role switch has to be explicit.
--
-- Session-scoped SET ROLE rather than SET LOCAL: Prisma does not guarantee the
-- whole file runs inside one transaction, and SET LOCAL outside a transaction
-- is silently a no-op. RESET ROLE at the end returns the connection.

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

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

RESET ROLE;
