import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The extension's own guard — not the database boundary.
 *
 * This file exists because its one assertion goes through the ORM on purpose,
 * and rls-isolation.test.ts promises in its header that everything in it
 * bypasses the ORM deliberately. A counterexample sitting inside that file is
 * how the next person reads it as precedent and adds an ORM test that quietly
 * proves nothing — which is exactly what happened once already, to three of
 * the vault isolation tests.
 *
 * What is under test here is the Prisma extension built by withCompany: for
 * every model in COMPANY_SCOPED_MODELS it injects the active company into
 * `where` clauses and rejects a `create` naming a different one.
 *
 * That rejection is worth asserting for a reason RLS does not cover. Without
 * it the extension would silently *overwrite* the caller's companyId with the
 * scope's, and the write would succeed — landing in the right company, so no
 * policy is violated and nothing raises. Safe, and wrong: a call site that
 * believes it is writing to another company is a bug, not something to quietly
 * correct into working code.
 *
 * So this is a convenience-layer test with a real purpose, and it must not be
 * mistaken for proof of isolation. The database refusing is proved next door,
 * in raw SQL, with the policies dropped to confirm it.
 */

let alpha: SeededCompany;
let beta: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

afterEach(async () => {
  await truncateAll();
});

describe("the withCompany extension", () => {
  it("rejects a create naming a company other than the active scope", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.user.create({
          data: {
            companyId: beta.id,
            fullName: "Smuggled",
            email: "x@beta.test",
            username: "smuggled_orm",
            passwordHash: "$argon2id$placeholder",
            phoneE164: "+919876500001",
          },
        }),
      ),
    ).rejects.toThrow(/cannot create a row for company/i);
  });

  it("refuses before the statement reaches the database", async () => {
    /*
     * The distinction that makes the test above worth keeping separate from
     * the isolation suite: this rejection is the extension's, not a policy's.
     * It carries the extension's own message rather than Postgres's
     * "row-level security", and it would still fire with RLS switched off.
     */
    let caught: unknown;

    try {
      await withCompany(alpha.id, (db) =>
        db.user.create({
          data: {
            companyId: beta.id,
            fullName: "Smuggled",
            email: "y@beta.test",
            username: "smuggled_orm_2",
            passwordHash: "$argon2id$placeholder",
            phoneE164: "+919876500003",
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);

    /* Empty when nothing threw, which fails the positive assertion below. */
    const message = caught instanceof Error ? caught.message : "";

    expect(message).toMatch(/cannot create a row for company/i);
    expect(message).not.toMatch(/row-level security/i);
  });
});
