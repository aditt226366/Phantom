-- Resolve a company from a webhook path segment.
--
-- No schema change, so there is no Prisma-generated section in this file.
--
-- This is the third sanctioned way a company id comes into existence, after
-- the session row and resolveCompany()'s existing five kinds. An inbound
-- webhook carries no session, so the id must come from the database rather
-- than from the request: read the key, resolve it here, then open withCompany
-- with the id this function returned. Passing anything from the request body
-- to withCompany is a total bypass of every policy in the schema.
--
-- ---------------------------------------------------------------------------
-- Why this kind does NOT check deactivated_at, when all five others do
-- ---------------------------------------------------------------------------
--
-- 20260815050000 extended the deactivation clause to every kind deliberately,
-- and this migration deliberately breaks that pattern. The asymmetry is the
-- point, so it is written down here rather than discovered as a bug.
--
-- Every other kind answers "may this PERSON act". A suspended workspace must
-- not be signable-into, verifiable, or resettable, so the clause belongs there.
--
-- This kind answers "did this THIRD PARTY tell us something true". A suspended
-- workspace's customers keep messaging it and Meta keeps delivering. Refusing
-- resolution would mean a 404 to Meta, and after roughly seven days of failed
-- deliveries Meta disables the subscription outright - so reactivating the
-- company would leave a dead webhook that a human has to re-enable in Business
-- Manager, with no signal anywhere that it is off, and every message sent
-- during the suspension gone.
--
-- So resolution succeeds, the delivery is recorded, and the WORKER refuses to
-- act on it. Suspension stops a company from doing things; it does not mean we
-- throw away evidence that arrived while it was suspended.
--
-- ---------------------------------------------------------------------------
-- Why the branch also constrains provider
-- ---------------------------------------------------------------------------
--
-- 20260815110000 gave webhook_key a NOT NULL default, so every integration has
-- one - including GOOGLE_SHEETS and META_ADS. Without this constraint a Sheets
-- integration's key would resolve successfully, the handler would open the
-- correct company, and then fail hunting for WhatsApp credentials that were
-- never there. Not a cross-tenant leak, but a confusing failure at the least
-- debuggable point in the system: an endpoint only Meta calls, over a tunnel,
-- with no session and no user watching.
--
-- The in-scope re-find of the integration carries the same constraint.
--
-- This is also why the grant below is three columns rather than two: reading
-- provider requires being granted provider.
--
-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Column-level, following 20260815080000_narrow_resolver_grant. app_resolver
-- runs SECURITY DEFINER outside every policy, so the next column added to
-- integrations must not become visible to it for free - which is exactly how
-- deactivated_at became readable before anyone decided to grant it.
--
-- A policy is not a privilege: app_resolver needs both the GRANT and a policy,
-- because integrations has FORCE ROW LEVEL SECURITY and app_resolver matches
-- none of the existing app_runtime or app_admin policies.

GRANT SELECT ("company_id", "webhook_key", "provider") ON "integrations" TO app_resolver;

CREATE POLICY integrations_resolver_read ON "integrations"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);

-- ---------------------------------------------------------------------------
-- The function
-- ---------------------------------------------------------------------------
--
-- CREATE OR REPLACE rewrites the whole thing, so all six branches are restated
-- here and the five existing ones must survive untouched. They are load-bearing
-- for sign-in, session resolution, email verification and password reset - a
-- typo in one presents as "sign-in is broken" with nothing pointing at a
-- webhook migration.
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

  ELSIF kind = 'webhook' THEN
    -- No companies join, and no deactivated_at clause. See the header.
    SELECT i.company_id INTO result
      FROM integrations i
     WHERE i.webhook_key = key
       AND i.provider = 'WHATSAPP_CLOUD'::integration_provider;

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

RESET ROLE;
