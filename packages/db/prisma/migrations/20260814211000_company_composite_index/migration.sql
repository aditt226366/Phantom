-- Make the users index composite, leading with company_id.
--
-- CLAUDE.md rule 1 requires a composite index leading with company_id on every
-- tenant-owned table. The single-column index this replaces was redundant
-- anyway: Postgres can use the leading column of a composite index on its own,
-- so (company_id) was doing nothing that (company_id, created_at) does not,
-- while still costing a write on every insert.
--
-- The second column is created_at because that is what a user list is ordered
-- by. The schema-invariants test asserts the shape, not the choice.

DROP INDEX "users_company_id_idx";

CREATE INDEX "users_company_id_created_at_idx"
  ON "users" ("company_id", "created_at");
