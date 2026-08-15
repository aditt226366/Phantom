-- An opaque path segment Meta can post to.
--
-- Webhook routing is per-integration: /api/webhooks/whatsapp/{webhook_key}.
-- The alternative - one shared URL carrying a company id - puts an internal
-- identifier in a URL Meta stores on its own servers, renders in a UI that
-- customers screenshot, and that we cannot revoke. This key carries nothing,
-- and rotates without touching a credential.
--
-- ---------------------------------------------------------------------------
-- Why there is no FORCE ROW LEVEL SECURITY dance here
-- ---------------------------------------------------------------------------
--
-- Backfilling a tenant table normally needs one: integrations has FORCE RLS,
-- its policies are scoped TO app_runtime and app_admin, and whatsapp_owner
-- matches neither - so a bare UPDATE in a migration silently touches zero rows,
-- reports success, and the migration carries on. See
-- packages/db/tests/force-rls-backfill.test.ts.
--
-- This migration has no UPDATE. A volatile DEFAULT on ADD COLUMN is DDL, and
-- row-level security does not apply to DDL: Postgres rewrites the table and
-- evaluates gen_random_uuid() once per row, so every existing integration gets
-- a distinct key with no DML involved. The unique index then proves it - if the
-- default had been evaluated once and shared, this migration would fail here
-- rather than quietly leaving every company with the same webhook URL.
--
-- The default lives in the database rather than in application code so that no
-- row can exist without a key, including rows written by a migration or by a
-- future code path that has not thought about webhooks. 122 bits from
-- gen_random_uuid(), which is Postgres's strong RNG. Rotation is an explicit
-- UPDATE from the app in the same 32-hex shape.
--
-- The DDL below is Prisma's, unedited.

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "webhook_key" TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');

-- CreateIndex
CREATE UNIQUE INDEX "integrations_webhook_key_key" ON "integrations"("webhook_key");
