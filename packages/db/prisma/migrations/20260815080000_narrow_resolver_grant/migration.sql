-- Narrow app_resolver's reach into companies to the three columns it uses.
--
-- No schema change, so there is no Prisma-generated section in this file.
--
-- ---------------------------------------------------------------------------
-- Why this is worth a migration of its own
-- ---------------------------------------------------------------------------
--
-- app_resolver exists to answer one question - "which company does this opaque
-- key belong to" - from outside any company context, and the entire argument
-- for granting it that power is that it can see almost nothing. The
-- authentication schema granted whole-table SELECT on companies because
-- app_available_slug() needs `slug`, which handed it `name`, `plan`,
-- `created_at` and `updated_at` as well.
--
-- That went unnoticed until the deactivation clause was added in
-- 20260815050000: `deactivated_at` was readable by the resolver with no grant
-- of its own, purely because the existing one was wider than anyone intended.
-- The clause is correct, but it arrived for free, and a privilege that arrives
-- for free is one nobody decided to give.
--
-- Column-level now, so the next column added to companies is not automatically
-- visible to a role that runs SECURITY DEFINER outside every policy. Adding one
-- deliberately means adding it here, which is a diff in a migration.
--
-- What actually reads what, and nothing else does:
--   app_resolve_company()  id, deactivated_at   (join, and the suspension check)
--   app_available_slug()   slug                 (SELECT 1 ... WHERE slug = ...)
--
-- The equivalent grants on users, sessions, email_verification_tokens and
-- password_reset_tokens are still whole-table and have the same shape of
-- problem. Left alone here deliberately: each needs its own reading of which
-- columns the functions touch, and bundling four of those into one migration is
-- how one of them gets it wrong quietly.

REVOKE SELECT ON "companies" FROM app_resolver;

GRANT SELECT ("id", "slug", "deactivated_at") ON "companies" TO app_resolver;
