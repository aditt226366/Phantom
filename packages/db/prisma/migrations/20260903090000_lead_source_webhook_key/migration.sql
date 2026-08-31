-- The optional Apps Script path: a per-binding key, and a seventh lookup kind.
--
-- ---------------------------------------------------------------------------
-- What the webhook actually carries, which is nothing
-- ---------------------------------------------------------------------------
--
-- The script a tenant pastes into their spreadsheet fires on edit and asks us
-- to look now. It sends no rows, no company id and no payload worth trusting -
-- the poll that follows reads the sheet through the same credential and the
-- same cleaning as every other poll.
--
-- That is deliberate. A webhook that carried rows would be a second ingestion
-- path, with its own idea of what a header is and its own opportunity to skip
-- the unique index; and a webhook that carried a company id would be somebody
-- else's company id the first time anyone guessed a URL. This one is a
-- doorbell.
--
-- ---------------------------------------------------------------------------
-- Per binding, not per integration
-- ---------------------------------------------------------------------------
--
-- integrations already has a webhook_key, and reusing it would have saved this
-- column. It would also mean one script, pasted into one spreadsheet, is a
-- credential for every binding the tenant has - and revoking it by rotating the
-- integration's key would silently break the WhatsApp webhook, which is the
-- same column.
--
-- A key per binding means deleting a binding revokes exactly its own script,
-- and a script pasted into the wrong spreadsheet rings a bell for a sheet that
-- is then read correctly anyway.
--
-- ---------------------------------------------------------------------------
-- Why this needs a lookup kind rather than a query
-- ---------------------------------------------------------------------------
--
-- CLAUDE.md rule 3: a company id may originate in the session row, in
-- app_resolve_company, or in a job payload one of those two produced. An
-- inbound request from Google Apps Script has no session, so the id has to come
-- from the database - and the ordinary client cannot do that lookup, because
-- every read it makes is already scoped to a company it does not yet know.
--
-- So this is the seventh branch of the one SECURITY DEFINER function, and it
-- returns a single text value rather than a row, exactly like the six before
-- it.

-- ===========================================================================
-- THE KEY
-- ===========================================================================
--
-- The same generator integrations uses. Not a cuid: this appears in a URL a
-- tenant pastes into a script, and it has to be unguessable rather than merely
-- unique - a sequential or time-ordered id would let anybody who has one ring
-- the bell for the bindings created either side of it.

ALTER TABLE "lead_sources"
  ADD COLUMN "webhook_key" TEXT NOT NULL
  DEFAULT replace(gen_random_uuid()::text, '-', '');

CREATE UNIQUE INDEX "lead_sources_webhook_key_key"
  ON "lead_sources"("webhook_key");

-- ===========================================================================
-- GRANTS
-- ===========================================================================
--
-- Column-level, following 20260815080000_narrow_resolver_grant. app_resolver
-- runs SECURITY DEFINER outside every policy, so the next column added to
-- lead_sources must not become visible to it for free - which is exactly how
-- deactivated_at became readable on another table before anybody decided to
-- grant it.
--
-- Two columns and no more. The resolver needs to turn a key into a company id;
-- it has no business reading a spreadsheet id, a mapping or a cursor.
--
-- A policy is not a privilege: app_resolver needs both, because lead_sources
-- has FORCE ROW LEVEL SECURITY and app_resolver matches none of the app_runtime
-- or app_admin policies.

GRANT SELECT ("company_id", "webhook_key") ON "lead_sources" TO app_resolver;

CREATE POLICY lead_sources_resolver_read ON "lead_sources"
  AS PERMISSIVE FOR SELECT TO app_resolver USING (true);

-- ===========================================================================
-- THE FUNCTION
-- ===========================================================================
--
-- CREATE OR REPLACE rewrites the whole thing, so all seven branches are
-- restated here and the six existing ones must survive untouched. They are
-- load-bearing for sign-in, session resolution, email verification, password
-- reset and the WhatsApp webhook - a typo in one presents as "sign-in is
-- broken" with nothing pointing at a lead-source migration.
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
    -- No companies join, and no deactivated_at clause. See 20260815120000.
    SELECT i.company_id INTO result
      FROM integrations i
     WHERE i.webhook_key = key
       AND i.provider = 'WHATSAPP_CLOUD'::integration_provider;

  ELSIF kind = 'lead_source' THEN
    --
    -- This one DOES join companies and DOES check deactivated_at, which is the
    -- opposite of the branch above it. The asymmetry is deliberate both times.
    --
    -- 'webhook' resolves for a suspended company because Meta disables a
    -- subscription that keeps failing, so refusing there would cost the tenant
    -- their webhook and every message sent while they were suspended - evidence
    -- that arrived, which suspension should not throw away.
    --
    -- Nothing of the kind is true here. This bell only ever causes us to SEND,
    -- and a suspended workspace must not send. Google Apps Script is the
    -- tenant's own code in the tenant's own spreadsheet; it has no subscription
    -- to lose, and it will happily ring again after reactivation.
    --
    SELECT l.company_id INTO result
      FROM lead_sources l JOIN companies c ON c.id = l.company_id
     WHERE l.webhook_key = key AND c.deactivated_at IS NULL;

  ELSE
    RAISE EXCEPTION 'unknown lookup kind: %', kind;
  END IF;

  RETURN result;
END $$;

RESET ROLE;
