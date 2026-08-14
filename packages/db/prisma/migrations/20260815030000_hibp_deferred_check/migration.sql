-- Track whether the breach check ever actually ran.
--
-- Signup fails open when HaveIBeenPwned is unreachable, which is the right call
-- — an outage there must not take the signup funnel down — but until now
-- nothing closed the gap afterwards. The HIBP_UNAVAILABLE audit row recorded
-- that the control had been skipped and then that was the end of it.
--
-- hibp_checked_at is null when the check has never completed. The next
-- successful sign-in retries it, because that is the only moment the plaintext
-- exists again: the stored value is an Argon2id hash and HIBP is indexed by
-- SHA-1 of the password itself.
--
-- password_breached_at is advisory. A hit does not block sign-in — locking
-- someone out of an account they can demonstrably authenticate to is worse than
-- the risk it mitigates, and leaves them no route to fix it.

ALTER TABLE "users"
  ADD COLUMN "hibp_checked_at" TIMESTAMP(3),
  ADD COLUMN "password_breached_at" TIMESTAMP(3);

-- Existing rows keep NULL, which is correct: whether their signup checked
-- successfully was never recorded, so the honest state is "unknown", and
-- unknown is exactly what triggers the re-check.

-- ALTER TYPE ... ADD VALUE is permitted inside a transaction from PostgreSQL 12
-- onwards, provided the new value is not *used* in the same transaction. These
-- are only declared here; the first row using them is written at runtime.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'HIBP_CHECKED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_BREACHED';
