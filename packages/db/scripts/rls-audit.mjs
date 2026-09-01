/**
 * The destructive policy audit, as a script rather than a shell one-liner.
 *
 * ===========================================================================
 * What it is for
 * ===========================================================================
 *
 * The source-level check (`no-orm-in-isolation.test.ts`) catches an isolation
 * assertion written through the ORM, where the extension's injected filter
 * makes it pass with every policy dropped. Only this catches an assertion that
 * is green for some OTHER wrong reason - a row so incomplete a NOT NULL
 * rejected it before the policy under test could, a `textContent` match on an
 * element whose name comes from an aria-label, a fixture that never wrote what
 * the test claims to read.
 *
 * So: disable RLS on every tenant table, run the db suite, and confirm that
 * everything outside the allowlist FAILS. A test still passing is the finding.
 *
 * ===========================================================================
 * Why a file in the repo and not three lines pasted into psql
 * ===========================================================================
 *
 * The conventions record two incidents from hand-rolled DDL surgery, and both
 * cost an afternoon: a shell one-liner that ate a backslash and stored the hex
 * of `%5044462d` instead of `%PDF-`, and a probe killed mid-run that left a
 * column behind in no migration and no schema file.
 *
 * This is recoverable by construction. It only ever DISABLEs and re-ENABLEs -
 * it never drops a policy, so there is no policy text to retype - and the
 * documented recovery is `npm run db:nuke -- test` regardless, because the
 * migrations are the only copy of that DDL worth trusting.
 *
 * Refuses anything but the test database, for the reason db-nuke does: the
 * whole point of the script is to take the boundary off.
 *
 *   node packages/db/scripts/rls-audit.mjs off
 *   npx vitest run --project db          # expect widespread failures
 *   npm run db:nuke -- test              # the real restore
 */
import pg from "pg";
import { testDatabaseUrl } from "./db-urls.mjs";

const mode = process.argv[2];

if (mode !== "off" && mode !== "on") {
  console.error("usage: rls-audit.mjs off|on");
  process.exit(1);
}

const url = testDatabaseUrl();

/*
 * The same guard db-nuke.mjs carries, and for a sharper reason: this script's
 * entire job is to remove tenant isolation. Loopback alone is not enough -
 * port-forwards and SSH tunnels put production on localhost routinely - so the
 * database NAME has to be the test one as well.
 */
const parsed = new URL(url);
const database = parsed.pathname.replace(/^\//, "");

if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
  console.error(`refusing: ${parsed.hostname} is not loopback`);
  process.exit(1);
}

if (database !== "whatsapp_os_test") {
  console.error(`refusing: ${database} is not whatsapp_os_test`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  /* Discovered, never listed. A hand-written list silently stops covering the
     next table somebody adds, which is how truncateAll went wrong. */
  const { rows } = await client.query(
    `SELECT c.relname AS t
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity
      ORDER BY 1`,
  );

  for (const { t } of rows) {
    if (mode === "off") {
      await client.query(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
    } else {
      await client.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    }
  }

  console.log(
    mode === "off"
      ? `RLS disabled on ${rows.length} tables. Run the db suite; anything still passing outside the allowlist is the finding. Restore with: npm run db:nuke -- test`
      : `RLS re-enabled and forced on ${rows.length} tables.`,
  );
} finally {
  await client.end();
}
