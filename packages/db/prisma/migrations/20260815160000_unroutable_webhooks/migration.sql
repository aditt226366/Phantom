-- Deliveries that arrived and could not be accepted.
--
-- Global, and that is the point: an unknown key resolves to no company, so
-- there is nothing to attribute a tenant-scoped row to. Listed in GLOBAL_TABLES
-- with that reason.
--
-- ---------------------------------------------------------------------------
-- The throttle is keyed on the source address, never on the webhook key
-- ---------------------------------------------------------------------------
--
-- LoginScope.WEBHOOK is added here for it, using the same sentinel-username
-- shape signup throttling already uses.
--
-- Keying it on the webhook key would be a denial of service against exactly the
-- failure the resolver's deactivation asymmetry exists to prevent. Anyone who
-- learns a tenant's URL could flood it with bad signatures until that key is
-- locked out; genuine Meta deliveries would then be refused, failures would
-- accumulate, and after roughly seven days Meta disables the subscription. An
-- attacker would be using our own protection to sever a customer's WhatsApp.
--
-- So: throttle per hashed source address, and only for requests whose key does
-- not resolve or whose signature does not verify. A request carrying a valid
-- key with a valid signature is never throttled - it is Meta, the app secret is
-- cached, and the remaining work is one insert.
--
-- What every path returns, and why it is not uniform:
--
--   unknown key        200. Not Meta, nothing to preserve, and a non-2xx counts
--                      toward disablement.
--   bad signature      200. Usually a real tenant with a stale app secret;
--                      refusing would burn their subscription down.
--   throttled          200. Same reasoning.
--   genuine, but we
--   cannot accept it   NOT 200. A 200 tells Meta the message was accepted and
--                      it will never send it again. Anything that really is
--                      Meta must fail with a status that makes it retry.
--
-- That last line is the one to keep: shedding load with a 200 loses customer
-- messages silently and permanently.
--
-- ---------------------------------------------------------------------------
-- The table is attacker-writable, so it is bounded
-- ---------------------------------------------------------------------------
--
-- An unauthenticated POST to any path creates a row here, and rotating the key
-- in the URL mints a fresh one every time - so a per-key table cannot bound
-- itself. One row per key hash with a counter rather than one row per request
-- keeps a flood from a single URL flat; the per-IP throttle above is what
-- bounds a flood across many URLs. Both are needed, and neither is sufficient.
--
-- The key is stored as a sha256. For BAD_SIGNATURE it is a real tenant's live
-- webhook key, and this table is read by the platform admin rather than the
-- tenant, so hashing keeps it from becoming a list of working webhook URLs.
--
-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- 30 days, same as whatsapp_webhook_events, and the last_seen_at index is what
-- reads it.
--
-- Unlike that table this prune is a single statement with no fan-out. The
-- difference is worth stating because the two land one commit apart and will
-- otherwise look inconsistent: whatsapp_webhook_events is tenant-scoped, so a
-- DELETE without a company context matches zero rows under RLS and the prune
-- has to be driven per company from the web side. This table has no policies to
-- satisfy, so one DELETE covers the installation.
--
-- The DDL below is Prisma's, unedited.

-- CreateEnum
CREATE TYPE "unroutable_reason" AS ENUM ('UNKNOWN_KEY', 'BAD_SIGNATURE');

-- AlterEnum
ALTER TYPE "login_scope" ADD VALUE 'WEBHOOK';

-- CreateTable
CREATE TABLE "unroutable_webhooks" (
    "id" TEXT NOT NULL,
    "webhook_key_hash" TEXT NOT NULL,
    "reason" "unroutable_reason" NOT NULL,
    "company_id" TEXT,
    "last_ip_hash" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unroutable_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unroutable_webhooks_webhook_key_hash_key" ON "unroutable_webhooks"("webhook_key_hash");

-- CreateIndex
CREATE INDEX "unroutable_webhooks_last_seen_at_idx" ON "unroutable_webhooks"("last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "unroutable_webhooks_company_id_last_seen_at_idx" ON "unroutable_webhooks"("company_id", "last_seen_at" DESC);

-- AddForeignKey
ALTER TABLE "unroutable_webhooks" ADD CONSTRAINT "unroutable_webhooks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- SECURITY
-- ===========================================================================
--
-- No RLS, deliberately: a global table has no company_id to scope a policy on.
-- The boundary here is the grant instead, and it is narrower than the default.
--
-- app_runtime WRITES this table - the webhook endpoint runs as the tenant
-- runtime, and recording an unacceptable delivery is the whole point. But it
-- must not READ it: the rows name which companies are failing verification and
-- how often, which is cross-tenant information no tenant request should be able
-- to enumerate. Default privileges had given it full CRUD when the table was
-- created.
--
-- So: INSERT and UPDATE, plus SELECT on exactly three columns. Each is forced
-- by the upsert rather than chosen, which is why it is three and not one:
--
--   id                 RETURNING names it, and Postgres requires SELECT on
--                      every column a RETURNING clause returns.
--   webhook_key_hash   ON CONFLICT (webhook_key_hash) reads the arbiter column.
--                      Without it even ON CONFLICT DO NOTHING is refused -
--                      measured, not assumed.
--   attempt_count      `SET attempt_count = attempt_count + 1` reads the column
--                      it writes.
--
-- What stays unreadable is what matters: company_id, reason, last_ip_hash and
-- the timestamps. A tenant request cannot enumerate which companies are failing
-- verification, how often, or from where. Granting the whole table to satisfy
-- the upsert would have handed back precisely the thing the revoke exists for.
--
-- app_admin keeps its default CRUD; the operator view reads through it.
--
-- login_attempts is the precedent for a global table the runtime writes: it has
-- to record a failure for a username that may not exist.

REVOKE ALL ON "unroutable_webhooks" FROM app_runtime;
GRANT INSERT, UPDATE ON "unroutable_webhooks" TO app_runtime;
GRANT SELECT ("id", "webhook_key_hash", "attempt_count") ON "unroutable_webhooks" TO app_runtime;
