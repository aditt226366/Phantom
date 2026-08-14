-- Separate tenant and admin lockout counters.
--
-- login_attempts was keyed (username, ip) across the whole installation, which
-- silently coupled two unrelated account spaces: a platform admin called "ada"
-- and a tenant user called "ada" shared one counter, so five failed tenant
-- sign-ins would lock the admin out, and an attacker who knew an admin username
-- could lock that admin out by attacking the tenant login instead. The
-- reverse — a locked admin blocking a paying customer's sign-in — is worse.
--
-- The scope is part of the unique key rather than a separate table because the
-- counting, backoff and sweep logic are identical; only the namespace differs.

CREATE TYPE "login_scope" AS ENUM ('TENANT', 'ADMIN');

ALTER TABLE "login_attempts"
  ADD COLUMN "scope" "login_scope" NOT NULL DEFAULT 'TENANT';

-- Every existing row predates admin auth, so the default above is correct for
-- all of them and no backfill is needed.
DROP INDEX "login_attempts_username_ip_key";

CREATE UNIQUE INDEX "login_attempts_scope_username_ip_key"
  ON "login_attempts" ("scope", "username", "ip");
