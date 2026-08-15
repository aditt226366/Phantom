-- Every timestamp column becomes timestamptz(3).
--
-- Prisma maps DateTime to timestamp(3) WITHOUT time zone by default, which
-- stores UTC wall-clock digits and no offset. The ORM is consistent about that
-- in both directions, so nothing was ever wrong through Prisma. Raw SQL was a
-- different matter, and 809b41d had to carry an incantation to stay correct:
--
--     ${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'
--
-- because binding a Date and casting ::timestamp keeps the wall-clock digits
-- and discards the offset - writing a value out by the NODE PROCESS's offset,
-- which on this machine is four hours. `now()` had the matching trap on the
-- server side, harmless only for as long as the session TimeZone stays UTC.
--
-- Both disappear here. A timestamptz column stores an instant, so there is no
-- wall clock to misread: a bound Date is correct with no cast, now() is
-- correct, and a session TimeZone change cannot move a stored value. The class
-- of bug is gone rather than documented.
--
-- ---------------------------------------------------------------------------
-- Why now, and what it would have cost later
-- ---------------------------------------------------------------------------
--
-- ALTER COLUMN ... TYPE rewrites the table and takes an ACCESS EXCLUSIVE lock.
-- Today every table is near-empty and the whole migration is instant. After
-- Phase 5 this is a rewrite of every message row in the installation, under a
-- lock that blocks reads, which is a maintenance window rather than a
-- migration. This is the last cheap moment and that is the reason for the
-- timing.
--
-- USING "col" AT TIME ZONE 'UTC' is the correct conversion precisely because
-- the stored digits are UTC: it reads them as UTC and produces the instant they
-- meant. Verified before writing this, by comparing the digits Prisma writes
-- against the digits the raw statement in conversations.ts writes - they were
-- identical, so one conversion is right for every row from either writer.
--
-- 64 columns across 22 tables. Defaults are unaffected: CURRENT_TIMESTAMP is
-- what Prisma emits for @default(now()) against both types, and Postgres
-- re-coerces the existing default through the type change.
--
-- packages/db/tests/timestamp-columns.test.ts holds the invariant afterwards -
-- an empty allowlist, so the next DateTime field that forgets
-- @db.Timestamptz(3) fails a test instead of quietly reintroducing the trap.

-- admin_audit_log
ALTER TABLE "admin_audit_log" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';

-- admin_repair_runs
ALTER TABLE "admin_repair_runs" ALTER COLUMN "started_at" TYPE timestamptz(3) USING "started_at" AT TIME ZONE 'UTC';

-- admin_sessions
ALTER TABLE "admin_sessions" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_sessions" ALTER COLUMN "last_seen_at" TYPE timestamptz(3) USING "last_seen_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_sessions" ALTER COLUMN "expires_at" TYPE timestamptz(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_sessions" ALTER COLUMN "revoked_at" TYPE timestamptz(3) USING "revoked_at" AT TIME ZONE 'UTC';

-- admin_users
ALTER TABLE "admin_users" ALTER COLUMN "last_login_at" TYPE timestamptz(3) USING "last_login_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_users" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "admin_users" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- audit_log
ALTER TABLE "audit_log" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';

-- companies
ALTER TABLE "companies" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "companies" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "companies" ALTER COLUMN "deactivated_at" TYPE timestamptz(3) USING "deactivated_at" AT TIME ZONE 'UTC';

-- contacts
ALTER TABLE "contacts" ALTER COLUMN "opted_out_at" TYPE timestamptz(3) USING "opted_out_at" AT TIME ZONE 'UTC';
ALTER TABLE "contacts" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "contacts" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- conversations
ALTER TABLE "conversations" ALTER COLUMN "last_inbound_at" TYPE timestamptz(3) USING "last_inbound_at" AT TIME ZONE 'UTC';
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" TYPE timestamptz(3) USING "last_message_at" AT TIME ZONE 'UTC';
ALTER TABLE "conversations" ALTER COLUMN "window_expires_at" TYPE timestamptz(3) USING "window_expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "conversations" ALTER COLUMN "assigned_at" TYPE timestamptz(3) USING "assigned_at" AT TIME ZONE 'UTC';
ALTER TABLE "conversations" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "conversations" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- email_verification_tokens
ALTER TABLE "email_verification_tokens" ALTER COLUMN "expires_at" TYPE timestamptz(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "email_verification_tokens" ALTER COLUMN "consumed_at" TYPE timestamptz(3) USING "consumed_at" AT TIME ZONE 'UTC';
ALTER TABLE "email_verification_tokens" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';

-- integration_secrets
ALTER TABLE "integration_secrets" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "integration_secrets" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- integration_verifications
ALTER TABLE "integration_verifications" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';

-- integrations
ALTER TABLE "integrations" ALTER COLUMN "last_verified_at" TYPE timestamptz(3) USING "last_verified_at" AT TIME ZONE 'UTC';
ALTER TABLE "integrations" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "integrations" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- login_attempts
ALTER TABLE "login_attempts" ALTER COLUMN "locked_until" TYPE timestamptz(3) USING "locked_until" AT TIME ZONE 'UTC';
ALTER TABLE "login_attempts" ALTER COLUMN "last_failure_at" TYPE timestamptz(3) USING "last_failure_at" AT TIME ZONE 'UTC';

-- messages
ALTER TABLE "messages" ALTER COLUMN "occurred_at" TYPE timestamptz(3) USING "occurred_at" AT TIME ZONE 'UTC';
ALTER TABLE "messages" ALTER COLUMN "delivered_at" TYPE timestamptz(3) USING "delivered_at" AT TIME ZONE 'UTC';
ALTER TABLE "messages" ALTER COLUMN "read_at" TYPE timestamptz(3) USING "read_at" AT TIME ZONE 'UTC';
ALTER TABLE "messages" ALTER COLUMN "failed_at" TYPE timestamptz(3) USING "failed_at" AT TIME ZONE 'UTC';
ALTER TABLE "messages" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "messages" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- password_reset_tokens
ALTER TABLE "password_reset_tokens" ALTER COLUMN "expires_at" TYPE timestamptz(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_reset_tokens" ALTER COLUMN "consumed_at" TYPE timestamptz(3) USING "consumed_at" AT TIME ZONE 'UTC';
ALTER TABLE "password_reset_tokens" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';

-- sessions
ALTER TABLE "sessions" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "last_seen_at" TYPE timestamptz(3) USING "last_seen_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "expires_at" TYPE timestamptz(3) USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "revoked_at" TYPE timestamptz(3) USING "revoked_at" AT TIME ZONE 'UTC';

-- unroutable_webhooks
ALTER TABLE "unroutable_webhooks" ALTER COLUMN "first_seen_at" TYPE timestamptz(3) USING "first_seen_at" AT TIME ZONE 'UTC';
ALTER TABLE "unroutable_webhooks" ALTER COLUMN "last_seen_at" TYPE timestamptz(3) USING "last_seen_at" AT TIME ZONE 'UTC';

-- usage_events
ALTER TABLE "usage_events" ALTER COLUMN "occurred_at" TYPE timestamptz(3) USING "occurred_at" AT TIME ZONE 'UTC';

-- users
ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "email_verified_at" TYPE timestamptz(3) USING "email_verified_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "last_login_at" TYPE timestamptz(3) USING "last_login_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "password_changed_at" TYPE timestamptz(3) USING "password_changed_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "hibp_checked_at" TYPE timestamptz(3) USING "hibp_checked_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "password_breached_at" TYPE timestamptz(3) USING "password_breached_at" AT TIME ZONE 'UTC';

-- whatsapp_media
ALTER TABLE "whatsapp_media" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "whatsapp_media" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- whatsapp_numbers
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "metadata_refreshed_at" TYPE timestamptz(3) USING "metadata_refreshed_at" AT TIME ZONE 'UTC';
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';

-- whatsapp_webhook_events
ALTER TABLE "whatsapp_webhook_events" ALTER COLUMN "processed_at" TYPE timestamptz(3) USING "processed_at" AT TIME ZONE 'UTC';
ALTER TABLE "whatsapp_webhook_events" ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "whatsapp_webhook_events" ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at" AT TIME ZONE 'UTC';
