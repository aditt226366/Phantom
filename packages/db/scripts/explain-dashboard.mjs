import pg from "pg";
import { testAppDatabaseUrl, testSuperuserDatabaseUrl } from "./db-urls.mjs";

/**
 * EXPLAIN every windowed query on the dashboard, as the role that runs it.
 *
 *     npm run db:explain:dashboard
 *
 * ---------------------------------------------------------------------------
 * Why this is a script and not an assertion
 * ---------------------------------------------------------------------------
 *
 * A test that asserts "this plan uses an index" is a test of the table's size.
 * Postgres is right to sequential-scan a hundred rows, so such a test either
 * fails on a fresh database or forces every suite to seed fifty thousand rows
 * to be meaningful. It would then fail for a reason that is not a regression
 * the first time a planner heuristic changes.
 *
 * So this seeds enough volume for the choice to be real, prints the plans, and
 * leaves reading them to a person. It is run when a query on this page changes,
 * and its output goes in the phase document.
 *
 * ---------------------------------------------------------------------------
 * As app_runtime, inside a company context. Both halves matter.
 * ---------------------------------------------------------------------------
 *
 * RLS rewrites the query. `company_id = app_current_company()` is ANDed into
 * every scan before the planner sees it, so a plan measured as the owner - or
 * with no context set - is a plan for a different query. It is also why the
 * composite indexes lead with company_id: under RLS there is no such thing as a
 * query on this schema without that predicate.
 *
 * `app_current_company()` is STABLE, so its value is available at plan time and
 * the planner can use the index. That is the same property the time bounds need
 * and do not get from `now()`, which is what this script exists to demonstrate.
 *
 * ---------------------------------------------------------------------------
 * The comparison it is really making
 * ---------------------------------------------------------------------------
 *
 * Each query is planned twice: once with the bound the application actually
 * passes, and once with `now()` written inline. The second is what this phase
 * is written to avoid, and seeing the two plans side by side is the only way
 * the reason stays convincing a year from now.
 */

const SEED_CONVERSATIONS = 50_000;

const superuser = new pg.Client({
  connectionString: testSuperuserDatabaseUrl(),
});
const runtime = new pg.Client({ connectionString: testAppDatabaseUrl() });

await superuser.connect();
await runtime.connect();

const companyId = "c000explaindashboardfixture";

try {
  /*
   * Seeded through the superuser, because this is scaffolding rather than a
   * fixture the application produced - and because RLS would otherwise require
   * a context per insert for no benefit. Torn down in the finally.
   */
  await superuser.query(
    `INSERT INTO companies (id, slug, name, plan, created_at, updated_at)
     VALUES ($1, 'explain-dashboard', 'Explain Dashboard', 'PRO', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [companyId],
  );

  await superuser.query(
    `INSERT INTO integrations (id, company_id, provider, label, status, created_at, updated_at)
     VALUES ('i_explain', $1, 'WHATSAPP_CLOUD', 'Explain', 'CONNECTED', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [companyId],
  );

  await superuser.query(
    `INSERT INTO whatsapp_numbers
       (id, company_id, integration_id, phone_number_id, display_number, status, quality_rating, created_at, updated_at)
     VALUES ('n_explain', $1, 'i_explain', 'pn_explain', '+91 90000 00000', 'CONNECTED', 'GREEN', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [companyId],
  );

  console.log(`Seeding ${SEED_CONVERSATIONS} conversations…`);

  /*
   * Windows spread over four days. A dataset where every window falls inside
   * the horizon would make the index look good for the wrong reason - the
   * planner's choice is only interesting when the predicate is selective.
   */
  await superuser.query(
    `INSERT INTO contacts (id, company_id, wa_id, phone_e164, created_at, updated_at)
     SELECT 'ct_' || g, $1, 'wa_' || g, '+9190000' || lpad(g::text, 5, '0'),
            now() - (g || ' minutes')::interval, now()
       FROM generate_series(1, $2) g
     ON CONFLICT DO NOTHING`,
    [companyId, SEED_CONVERSATIONS],
  );

  await superuser.query(
    `INSERT INTO conversations
       (id, company_id, contact_id, whatsapp_number_id, source,
        last_inbound_at, last_message_at, window_expires_at, unread_count,
        created_at, updated_at)
     SELECT 'cv_' || g, $1, 'ct_' || g, 'n_explain', 'INBOUND',
            now() - (g || ' minutes')::interval,
            now() - (g || ' minutes')::interval,
            now() + ((g % 5760) || ' minutes')::interval,
            0,
            now() - (g || ' minutes')::interval, now()
       FROM generate_series(1, $2) g
     ON CONFLICT DO NOTHING`,
    [companyId, SEED_CONVERSATIONS],
  );

  await superuser.query(`ANALYZE conversations`);
  await superuser.query(`ANALYZE contacts`);

  /*
   * The context, transaction-local, exactly as withCompany sets it. Everything
   * below runs inside this one transaction for that reason.
   */
  await runtime.query("BEGIN");
  await runtime.query(`SELECT set_config('app.company_id', $1, true)`, [
    companyId,
  ]);

  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 60_000);

  const cases = [
    {
      name: "closing windows — bound parameters (what the app does)",
      sql: `SELECT id, window_expires_at FROM conversations
             WHERE window_expires_at > $1 AND window_expires_at <= $2
             ORDER BY window_expires_at ASC LIMIT 6`,
      params: [now, horizon],
    },
    {
      name: "closing windows — now() inline (what it must not do)",
      sql: `SELECT id, window_expires_at FROM conversations
             WHERE window_expires_at > now()
               AND window_expires_at <= now() + interval '1 hour'
             ORDER BY window_expires_at ASC LIMIT 6`,
      params: [],
    },
    {
      name: "closing windows — the count beside the list",
      sql: `SELECT count(*) FROM conversations
             WHERE window_expires_at > $1 AND window_expires_at <= $2`,
      params: [now, horizon],
    },
    {
      name: "waiting for a human",
      sql: `SELECT id FROM conversations
             WHERE assigned_user_id IS NULL AND unread_count > 0
             ORDER BY last_message_at ASC LIMIT 6`,
      params: [],
    },
    {
      name: "recent threads",
      sql: `SELECT id FROM conversations
             WHERE last_message_at IS NOT NULL
             ORDER BY last_message_at DESC LIMIT 6`,
      params: [],
    },
    {
      name: "templates awaiting approval",
      sql: `SELECT id FROM whatsapp_templates
             WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 6`,
      params: [],
    },
    {
      name: "the rollup read",
      sql: `SELECT computed_at FROM dashboard_rollups WHERE company_id = $1`,
      params: [companyId],
    },
  ];

  for (const testCase of cases) {
    const { rows } = await runtime.query(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY OFF) ${testCase.sql}`,
      testCase.params,
    );

    console.log(`\n── ${testCase.name}`);
    for (const row of rows) console.log(`   ${row["QUERY PLAN"]}`);
  }

  await runtime.query("ROLLBACK");
} finally {
  /* The company cascades to everything seeded above. */
  await superuser.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  await runtime.end();
  await superuser.end();
}
