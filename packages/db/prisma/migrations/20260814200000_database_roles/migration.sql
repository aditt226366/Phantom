-- Two database roles.
--
-- The owner (whatsapp) runs migrations and owns every table. The application
-- connects as app_runtime, which owns nothing. That distinction is the entire
-- point: Postgres exempts a table's owner from its row-level security policies,
-- so an application connected as the owner would sail straight through every
-- policy added in the next migration, and the isolation tests would pass while
-- proving nothing.
--
-- app_admin is the platform-admin identity. It is deliberately NOT created with
-- BYPASSRLS: that attribute requires superuser to grant, which the master role
-- on a managed Postgres (RDS, Cloud SQL) does not have, so the migration would
-- fail on the first production deploy. Instead the RLS migration gives app_admin
-- its own explicit permissive policy per table. Forgetting one means the admin
-- panel cannot see that table — a visible, fail-closed bug, rather than an
-- invisible role attribute that silently grants everything.
--
-- Role identity lives here, without a password, so it is committed and
-- idempotent. LOGIN and the password are granted out of band by
-- `npm run db:roles`, which is also what documents the production step.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN;
  END IF;
END $$;

-- CONNECT is granted to PUBLIC by default; being explicit means the grant
-- survives an installation that has revoked it. format() because GRANT takes no
-- expressions, and this migration runs against both the dev and test databases.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO app_runtime, app_admin',
    current_database()
  );
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime, app_admin;

-- Retroactive: ALTER DEFAULT PRIVILEGES only affects tables created *after* it
-- runs, so existing tables need an explicit grant as well.
--
-- TRUNCATE is deliberately withheld. TRUNCATE ignores row-level security
-- entirely, so granting it would hand app_runtime a one-statement bypass of
-- every policy in the next migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO app_runtime, app_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO app_runtime, app_admin;

-- Prospective: applies to tables created later by this role.
--
-- Caveat worth knowing: default privileges are keyed to the role that CREATES
-- the object. If production migrations ever run as a different role, future
-- tables silently get no grants and every query fails with "permission denied".
-- The schema-invariants test asserts the grants per table, and is the real
-- guard against that.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_admin;
