-- Re-point default privileges at the new table owner.
--
-- ALTER DEFAULT PRIVILEGES is keyed to the role that CREATES an object, not to
-- the schema. The entries from the roles migration were written while the
-- container superuser was creating tables, so they describe a situation that
-- can no longer happen: migrations now run as whatsapp_owner.
--
-- Left alone, every table added from here on would be created by
-- whatsapp_owner, match no default-privilege entry, and receive no grants at
-- all — so app_runtime would get "permission denied" on a table that otherwise
-- looks completely correct. The schema-invariants grant assertions are what
-- catch that, and this migration is what prevents it.
--
-- No FOR ROLE clause: it defaults to current_user, which is whatsapp_owner
-- when this runs. Spelling out FOR ROLE whatsapp_owner would break any
-- environment whose owner role is named differently.
--
-- The stale superuser-owned entries are revoked by `npm run db:roles`, which
-- is the only thing holding a superuser connection.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_admin;

-- Existing tables are unaffected by the above — default privileges only apply
-- to objects created later — so re-assert the current grants explicitly. This
-- is a no-op when the roles migration already granted them, and it is the
-- statement that matters if this migration ever runs against a database
-- restored from before that one.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO app_runtime, app_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO app_runtime, app_admin;
