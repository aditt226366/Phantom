import "./_load-env.mjs";
import pg from "pg";
import {
  createKeyring,
  encrypt,
  hashPassword,
  last4Of,
  secretAad,
} from "@whatsapp-os/core";
import { FIXTURE } from "../tests/visual/fixture.ts";
import {
  TEST_DATABASE_NAME,
  testAdminDatabaseUrl,
  testAppDatabaseUrl,
  testDatabaseUrl,
  testSuperuserDatabaseUrl,
} from "../../../packages/db/scripts/db-urls.mjs";

/**
 * The fixture the screenshot suite renders.
 *
 *     npm run visual:seed
 *
 * ---------------------------------------------------------------------------
 * Why every value here is a literal
 * ---------------------------------------------------------------------------
 *
 * A screenshot suite is only worth having if a diff means something changed.
 * Seeded ids, names, counts and timestamps are all fixed, so a pixel that
 * moves moved because the markup or the CSS moved. The alternative — sign up a
 * company and let cuid() and now() fill in the rest — produces a suite whose
 * baselines never match twice, which people learn to re-record without
 * looking, which is worse than no suite at all.
 *
 * That is also why nothing in this app renders a relative time. There is no
 * "2 minutes ago" anywhere; every timestamp goes through formatTimestamp in
 * Asia/Kolkata, so a literal in this file renders as the same string forever.
 *
 * ---------------------------------------------------------------------------
 * The one thing that is not frozen
 * ---------------------------------------------------------------------------
 *
 * "API calls today" and "Est. spend this month" are windowed on the platform
 * day and month, computed when the page renders rather than when this runs.
 * Their events are therefore stamped at the current instant, which is inside
 * both windows by definition — the count and the total are fixed even though
 * the timestamps are not, and neither timestamp is rendered anywhere.
 *
 * The residue is that a run which crosses midnight IST between the seed and
 * the screenshot sees those two cards go to zero. Re-seed and re-run. Freezing
 * it properly would mean the application reading its clock from somewhere a
 * test could set, and a production code path that exists only for tests is a
 * worse trade than a rare re-run.
 *
 * ---------------------------------------------------------------------------
 * Which database
 * ---------------------------------------------------------------------------
 *
 * The test database, never the development one — this truncates. The
 * connection strings are redirected before anything reads them and then
 * checked, the same belt-and-braces the vitest setup files use, because the
 * failure mode of getting it wrong is silent: no error, just somebody's local
 * data gone.
 *
 * Migrations are not run here. `npm test` migrates the test database in its
 * global setup and `npm run verify` runs it first, so by the time this
 * executes the schema is current. A missing table is reported as such rather
 * than as a query error.
 */

for (const name of ["DATABASE_URL", "DATABASE_URL_APP", "DATABASE_URL_ADMIN"]) {
  const url = new URL(process.env[name] ?? "postgres://localhost/none");
  if (url.pathname.replace(/^\//, "") !== TEST_DATABASE_NAME) {
    /* Redirected rather than required in .env: developers point these at the
       development database and should not have to remember not to. */
    process.env[name] = {
      DATABASE_URL: testDatabaseUrl,
      DATABASE_URL_APP: testAppDatabaseUrl,
      DATABASE_URL_ADMIN: testAdminDatabaseUrl,
    }[name]();
  }
}

/* ------------------------------------------------------------------ */
/* The fixture                                                         */
/* ------------------------------------------------------------------ */

const COMPANY = {
  active: FIXTURE.companyId,
  deactivated: "c000visualfixturecompany2",
  enterprise: "c000visualfixturecompany3",
};

const INTEGRATION = {
  sheets: "c000visualfixtureintegra1",
  whatsapp: "c000visualfixtureintegra2",
  otherCompany: "c000visualfixtureintegra3",
  thirdCompany: "c000visualfixtureintegra4",
};

/** Literal UTC instants. Rendered in IST, so each is nine and a half hours on. */
const T = {
  companyCreated: "2026-02-11T04:30:00Z", //  11/02/2026 10:00:00
  otherCreated: "2026-01-06T04:30:00Z", //    06/01/2026 10:00:00
  thirdCreated: "2025-11-19T04:30:00Z", //    19/11/2025 10:00:00
  ownerLastLogin: FIXTURE.ownerLastLoginAt, //  14/08/2026 14:42:44
  otherLastLogin: "2026-06-02T11:05:09Z", //  02/06/2026 16:35:09
  deactivated: "2026-07-28T06:00:00Z", //     28/07/2026 11:30:00
  repairStarted: "2026-08-14T18:30:00Z", //   15/08/2026 00:00:00
  verified: [
    "2026-08-14T19:41:02Z",
    "2026-08-14T19:40:58Z",
    "2026-08-14T19:40:51Z",
    "2026-08-12T05:22:17Z",
    "2026-08-09T14:03:40Z",
  ],
};

/**
 * Credential values, chosen only for how they mask.
 *
 * Each is at least MIN_LENGTH_FOR_LAST4 characters so every card renders a
 * last4 rather than a mix of masked and blank — the blank case is worth
 * seeing, but the card that shows it is META_ADS, which has no secrets at all.
 *
 * They are not real credentials and never reach a provider: nothing in the
 * suite clicks Test Connection, because a screenshot of a network round-trip
 * is a screenshot of whether the network was up.
 */
const SECRETS = {
  [INTEGRATION.sheets]: {
    GOOGLE_SHEETS_ID: "1fixtureSheetIdAAAAAAAAAAAAAAAAAAAAAAAA9021",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sheets-sync@northwind-fixture.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nMIIfixturekeymaterialnotreal\n-----END PRIVATE KEY-----\n",
  },
  [INTEGRATION.whatsapp]: {
    WHATSAPP_PHONE_NUMBER_ID: "109384756201847",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "204857610394827",
    WHATSAPP_ACCESS_TOKEN: "EAAfixtureaccesstokenvalue0000000000004417",
    WHATSAPP_VERIFY_TOKEN: "fixture-verify-token-6620",
    WHATSAPP_APP_SECRET: "fixture-app-secret-8f2a1c7d4b90",
  },
  [INTEGRATION.otherCompany]: {
    WHATSAPP_PHONE_NUMBER_ID: "118273645500912",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "227364554001283",
    WHATSAPP_ACCESS_TOKEN: "EAAfixturesecondcompanytoken000000000883",
    WHATSAPP_VERIFY_TOKEN: "fixture-verify-second-0917",
    WHATSAPP_APP_SECRET: "fixture-app-secret-second-31d6cf",
  },
  [INTEGRATION.thirdCompany]: {
    GOOGLE_SHEETS_ID: "1fixtureThirdSheetIdBBBBBBBBBBBBBBBBBB7734",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "reports@ashgrove-fixture.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nMIIfixturethirdkeymaterial\n-----END PRIVATE KEY-----\n",
  },
};

/**
 * Everything the two windowed cards count.
 *
 * Twelve events, so "API calls today" reads 12; ₹ and $ priced separately so
 * the per-currency rule is visible rather than asserted; two unpriced, so the
 * caveat beside the total is on screen. Stamped at the current instant — see
 * the note at the top of this file.
 */
const USAGE = [
  ...Array.from({ length: 6 }, (_, index) => ({
    kind: "integration.verify",
    costMicros: 250_000n,
    currency: "INR",
    dedupe: `fixture-inr-${index}`,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    kind: "ai.reply",
    costMicros: 31_000n,
    currency: "USD",
    dedupe: `fixture-usd-${index}`,
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    kind: "message.outbound",
    costMicros: null,
    currency: null,
    dedupe: `fixture-unpriced-${index}`,
  })),
];

/* ------------------------------------------------------------------ */
/* Writing it                                                          */
/* ------------------------------------------------------------------ */

const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
await client.connect();

/*
 * Superuser, because the owner cannot read these tables: FORCE ROW LEVEL
 * SECURITY subjects whatsapp_owner to policies written TO app_runtime, so a
 * plain TRUNCATE-and-INSERT as the owner is a permission error on some tables
 * and a silent no-op on others. A superuser bypasses RLS unconditionally,
 * which is what a fixture wants and what application code must never have.
 */

try {
  const { rows: present } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = new Set(present.map((row) => row.tablename));
  const missing = ["companies", "integrations", "usage_events", "admin_users"].filter(
    (table) => !tables.has(table),
  );

  if (missing.length > 0) {
    console.error(
      `${TEST_DATABASE_NAME} is missing ${missing.join(", ")}.\n` +
        "Run `npm run db:test:setup` first — this script seeds, it does not migrate.",
    );
    process.exit(1);
  }

  await client.query(`
    TRUNCATE TABLE "integration_secrets", "integration_verifications",
                   "integrations", "usage_events", "sessions",
                   "email_verification_tokens", "password_reset_tokens",
                   "audit_log", "login_attempts", "users", "companies",
                   "admin_sessions", "admin_audit_log", "admin_repair_runs",
                   "admin_users"
    RESTART IDENTITY CASCADE
  `);

  const tenantHash = await hashPassword(FIXTURE.tenant.password);
  const adminHash = await hashPassword(FIXTURE.admin.password);

  /* Companies: one healthy, one deactivated, one on the top plan. Three plans
     and both statuses is the smallest set that makes the donut and the plan
     distribution show more than one segment. */
  await client.query(
    `INSERT INTO companies (id, slug, name, plan, deactivated_at, created_at, updated_at)
     VALUES ($1, 'northwind-traders', 'Northwind Traders', 'PRO', NULL, $4, $4),
            ($2, 'brightleaf-organics', 'Brightleaf Organics', 'STARTER', $5, $6, $6),
            ($3, 'ashgrove-logistics', 'Ashgrove Logistics', 'ENTERPRISE', NULL, $7, $7)`,
    [
      COMPANY.active,
      COMPANY.deactivated,
      COMPANY.enterprise,
      T.companyCreated,
      T.deactivated,
      T.otherCreated,
      T.thirdCreated,
    ],
  );

  const users = [
    ["c000visualfixtureuser001", COMPANY.active, "Priya Menon", "priya@northwind.test", "priya_menon", "OWNER", "+919812345670", T.ownerLastLogin],
    ["c000visualfixtureuser002", COMPANY.active, "Rohan Iyer", "rohan@northwind.test", "rohan_iyer", "MEMBER", "+919812345671", null],
    ["c000visualfixtureuser003", COMPANY.active, "Sana Qureshi", "sana@northwind.test", "sana_q", "MEMBER", "+919812345672", null],
    ["c000visualfixtureuser004", COMPANY.deactivated, "Dev Kapoor", "dev@brightleaf.test", "dev_kapoor", "OWNER", "+919812345673", T.otherLastLogin],
    ["c000visualfixtureuser005", COMPANY.enterprise, "Meera Raghavan", "meera@ashgrove.test", "meera_r", "OWNER", "+919812345674", null],
  ];

  for (const [id, companyId, fullName, email, username, role, phone, lastLogin] of users) {
    await client.query(
      `INSERT INTO users (id, company_id, full_name, email, email_verified_at, username,
                          password_hash, phone_e164, role, password_changed_at,
                          last_login_at, hibp_checked_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $9, $5, $6, $7, $8, $9, $10, $9, $9, $9)`,
      [id, companyId, fullName, email, username, tenantHash, phone, role, T.companyCreated, lastLogin],
    );
  }

  await client.query(
    `INSERT INTO admin_users (id, username, password_hash, last_login_at, created_at, updated_at)
     VALUES ('c000visualfixtureadmin01', $1, $2, $3, $3, $3)`,
    [FIXTURE.admin.username, adminHash, T.companyCreated],
  );

  /* Integrations: connected, connected-with-a-recorded-failure, and absent.
     META_ADS gets no row at all, so one card renders its "not connected"
     state — the state an operator sees most often and the one a suite that
     only seeds happy paths never photographs. */
  await client.query(
    `INSERT INTO integrations (id, company_id, provider, label, status,
                               last_verified_at, last_error, created_at, updated_at)
     VALUES ($1, $5, 'GOOGLE_SHEETS',  'Order sheet',      'CONNECTED',     $6, NULL, $8, $8),
            ($2, $5, 'WHATSAPP_CLOUD', 'Primary number',   'CONNECTED',     $6, NULL, $8, $8),
            ($3, $9, 'WHATSAPP_CLOUD', 'Support number',   'NOT_CONNECTED', $7,
             'Meta Graph API returned 190: Error validating access token.', $8, $8),
            ($4, $10, 'GOOGLE_SHEETS', 'Consignment log',  'CONNECTED',     $6, NULL, $8, $8)`,
    [
      INTEGRATION.sheets,
      INTEGRATION.whatsapp,
      INTEGRATION.otherCompany,
      INTEGRATION.thirdCompany,
      COMPANY.active,
      T.verified[0],
      T.verified[3],
      T.companyCreated,
      COMPANY.deactivated,
      COMPANY.enterprise,
    ],
  );

  const keyring = createKeyring(
    process.env["ENCRYPTION_KEYS"],
    process.env["ENCRYPTION_KEY_ACTIVE"],
  );

  const companyOf = {
    [INTEGRATION.sheets]: COMPANY.active,
    [INTEGRATION.whatsapp]: COMPANY.active,
    [INTEGRATION.otherCompany]: COMPANY.deactivated,
    [INTEGRATION.thirdCompany]: COMPANY.enterprise,
  };

  let secretId = 0;
  for (const [integrationId, values] of Object.entries(SECRETS)) {
    const companyId = companyOf[integrationId];

    for (const [key, value] of Object.entries(values)) {
      /*
       * Sealed the way the application seals, AAD and all. A fixture holding
       * hand-written strings in the ciphertext column would render identically
       * — the panel only ever shows last4 — and would quietly stop being a
       * fixture the day someone points a decrypt at it.
       */
      const ciphertext = encrypt(
        value,
        keyring,
        secretAad(companyId, integrationId, key),
      );

      await client.query(
        `INSERT INTO integration_secrets (id, company_id, integration_id, key,
                                          ciphertext, key_id, last4, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          `c000visualfixturesecret${String(++secretId).padStart(2, "0")}`,
          companyId,
          integrationId,
          key,
          ciphertext,
          keyring.activeId,
          last4Of(value),
          T.companyCreated,
        ],
      );
    }
  }

  /* Verification history. Newest first in the log, a failure among them, and
     one row per company after the repair run's start so the panel's derived
     progress reads 3 of 3 rather than a number that drifts. */
  const verifications = [
    ["c000visualfixtureverif01", COMPANY.active, INTEGRATION.sheets, true, 200, null, null, T.verified[0]],
    ["c000visualfixtureverif02", COMPANY.active, INTEGRATION.whatsapp, true, 200, null, null, T.verified[1]],
    ["c000visualfixtureverif03", COMPANY.deactivated, INTEGRATION.otherCompany, false, 400,
      "Meta Graph API returned 190: Error validating access token.", "auth", T.verified[2]],
    ["c000visualfixtureverif04", COMPANY.enterprise, INTEGRATION.thirdCompany, true, 200, null, null, T.verified[2]],
    ["c000visualfixtureverif05", COMPANY.active, INTEGRATION.whatsapp, false, null,
      "The request timed out after 10000ms.", "transient", T.verified[3]],
    ["c000visualfixtureverif06", COMPANY.active, INTEGRATION.sheets, true, 200, null, null, T.verified[4]],
  ];

  for (const [id, companyId, integrationId, ok, status, error, kind, at] of verifications) {
    await client.query(
      `INSERT INTO integration_verifications (id, company_id, integration_id, ok,
                                              status_code, error, failure_kind,
                                              details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        companyId,
        integrationId,
        ok,
        status,
        error,
        kind,
        kind === "auth"
          ? JSON.stringify({ code: 190, error_subcode: 460, fbtrace_id: "AfixtureTraceId01" })
          : null,
        at,
      ],
    );
  }

  await client.query(
    `INSERT INTO admin_repair_runs (id, admin_user_id, total_companies, started_at)
     VALUES ('c000visualfixturerepair1', 'c000visualfixtureadmin01', 3, $1)`,
    [T.repairStarted],
  );

  /* The only rows stamped `now`. See the note at the top of the file. */
  let usageId = 0;
  for (const event of USAGE) {
    await client.query(
      `INSERT INTO usage_events (id, company_id, kind, quantity, cost_micros, currency,
                                 price_version, unpriced_reason, dedupe_key, occurred_at)
       VALUES ($1, $2, $3, 1, $4, $5, 1, $6, $7, now())`,
      [
        `c000visualfixtureusage${String(++usageId).padStart(3, "0")}`,
        COMPANY.active,
        event.kind,
        event.costMicros,
        event.currency,
        event.currency ? null : "no price entry for this kind",
        event.dedupe,
      ],
    );
  }

  console.log(
    `Seeded ${TEST_DATABASE_NAME}: 3 companies, ${users.length} users, ` +
      `4 integrations, ${secretId} secrets, ${verifications.length} verifications, ` +
      `${USAGE.length} usage events.`,
  );
} finally {
  await client.end();
}

process.exit(0);
