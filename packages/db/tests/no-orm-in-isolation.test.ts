import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The isolation suite must prove the boundary, not the convention.
 *
 * Every model in COMPANY_SCOPED_MODELS has its `companyId` filter injected by
 * the withCompany extension. A test that reads through the ORM therefore
 * passes with every policy in the database dropped: it demonstrates that the
 * convenience layer works, which is not what rls-isolation.test.ts claims to
 * demonstrate, and not what would still hold against a raw query someone adds
 * in six months.
 *
 * This is not hypothetical. Three of the five credential-vault isolation tests
 * were written through the ORM and passed with RLS switched off, and the
 * concurrent-scope test — whose entire purpose is proving the app.company_id
 * GUC does not bleed across pooled connections — was masked by the same
 * injected filter, so it would have stayed green if the GUC leaked on every
 * request. They were found by dropping the policies and running the suite, not
 * by reading the tests.
 *
 * Hence a check rather than a note in a document. The allowlist below is the
 * only way out, so a sixth exception is a diff in a security test rather than
 * a habit that spreads one test at a time.
 *
 * Scope: assertions, not fixtures. Seeding goes through withCompany and the
 * ORM deliberately — helpers.ts explains why — so only the bodies of `it`
 * blocks are examined, and setup declared outside them is untouched.
 */

const testsDir = dirname(fileURLToPath(import.meta.url));
const ISOLATION_SUITE = "rls-isolation.test.ts";

/**
 * Tests that are not about a policy, and so need no raw SQL.
 *
 * Each one would pass with RLS disabled, correctly: they assert role
 * attributes, catalog facts, fixture sanity, or a grant. Nothing here reads a
 * tenant row.
 */
const NOT_POLICY_TESTS = new Set<string>([
  /* Asserts pg_roles attributes: the suite is connected as a role RLS applies
     to. This is what stops every other test in the file being vacuous. */
  "is connected as a role that RLS applies to",
  /* Fixture sanity — two companies exist and differ. No SQL of its own. */
  "seeded two distinct companies",
  /* Owner attributes, from pg_roles: not a superuser, no BYPASSRLS. */
  "is not a superuser and does not bypass RLS",
  /* Ownership, from pg_tables. A catalog fact, not a row. */
  "owns these tables",
  /* About a GRANT. TRUNCATE ignores RLS by design — that is its whole point. */
  "can still TRUNCATE, which is why app_runtime must not",
]);

/**
 * A model call on the *scoped* client — db.user.findMany(, not db.$queryRaw.
 *
 * `db` is the name every withCompany callback binds, and it is the extended
 * client: the only one that injects a company filter, and so the only one that
 * can make an assertion pass without a policy.
 */
const SCOPED_ORM_CALL = /\bdb\.[a-z][A-Za-z0-9]*\.[a-zA-Z]+\s*\(/;

/**
 * Evidence the assertion actually reached the database unaided.
 *
 * Raw SQL through Prisma, a pg client query, or the *unscoped* `prisma`
 * client — which carries no extension, holds no company context, and is
 * therefore subject to exactly the policies under test. "returns nothing
 * through the ORM" is deliberately built on it, as the pair to the raw-SQL
 * version of the same claim.
 */
const UNMEDIATED_READ = /\$queryRaw|\$executeRaw|\.query\(|\bprisma\.[a-z]/;

interface TestBody {
  name: string;
  body: string;
}

/**
 * Split the suite into `it` bodies.
 *
 * Bounded at the closing `  });` rather than at the next `it(`, because a
 * describe's seeding helpers sit between the two and would otherwise be
 * attributed to the previous test — which is how a fixture's legitimate
 * db.integration.create() would fail this check.
 */
function testBodies(source: string): TestBody[] {
  const found: TestBody[] = [];
  const opener = /\n {2}it\(\s*"([^"]+)"/g;

  for (const match of source.matchAll(opener)) {
    const start = match.index;
    const closer = source.indexOf("\n  });", start);
    found.push({
      name: match[1]!,
      body: source.slice(start, closer === -1 ? source.length : closer),
    });
  }

  return found;
}

describe(`${ISOLATION_SUITE} assertions`, () => {
  const source = readFileSync(join(testsDir, ISOLATION_SUITE), "utf8");
  const bodies = testBodies(source);

  it("parsed the suite", () => {
    /*
     * A parser that matches nothing makes every check below vacuously true,
     * which is the same failure mode this file exists to catch. Assert the
     * count agrees with a plain count of `it(` in the source.
     */
    const declared = source.match(/\n {2}it\(/g)?.length ?? 0;

    expect(bodies.length).toBe(declared);
    expect(bodies.length).toBeGreaterThan(20);
  });

  it("never touches a model on the scoped client", () => {
    /*
     * The whole defect in one check. Seeding through the ORM is fine and
     * happens in helpers declared outside these bodies; asserting through it
     * is what passes with the policies dropped.
     */
    const offenders = bodies
      .filter((test) => SCOPED_ORM_CALL.test(test.body))
      .map((test) => test.name);

    expect(
      offenders.sort(),
      "these assertions would pass with every policy dropped — use $queryRaw",
    ).toEqual([]);
  });

  it("reaches the database unaided, or is named as not being a policy test", () => {
    const offenders = bodies
      .filter((test) => !NOT_POLICY_TESTS.has(test.name))
      .filter((test) => !UNMEDIATED_READ.test(test.body))
      .map((test) => test.name);

    expect(
      offenders.sort(),
      "no unmediated read: assert through raw SQL, or add the test to NOT_POLICY_TESTS with a reason",
    ).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    /*
     * An allowlist entry for a test that no longer exists is a renamed test
     * that quietly stopped being checked.
     */
    const names = new Set(bodies.map((test) => test.name));
    const stale = [...NOT_POLICY_TESTS].filter((name) => !names.has(name));

    expect(stale.sort(), "allowlisted tests that no longer exist").toEqual([]);
  });
});
