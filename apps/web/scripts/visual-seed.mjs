import "./_load-env.mjs";
import { createHash } from "node:crypto";
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
 * The two things that are not frozen, and the rule they share
 * ---------------------------------------------------------------------------
 *
 * Both are stamped `now()`, and both are safe for the same reason: they are
 * *decided on* at render time and never *rendered*. That is the rule. A value
 * this file stamps relative to the clock may drive a count, a badge or a
 * branch; the moment one is printed as a timestamp, this suite stops diffing.
 *
 * 1. "API calls today" and "Est. spend this month" are windowed on the
 *    platform day and month, computed when the page renders rather than when
 *    this runs. Their events are stamped at the current instant, which is
 *    inside both windows by definition — the count and the total are fixed
 *    even though the timestamps are not.
 *
 *    The residue is that a run which crosses midnight IST between the seed and
 *    the screenshot sees those two cards go to zero. Re-seed and re-run.
 *    Freezing it properly would mean the application reading its clock from
 *    somewhere a test could set, and a production code path that exists only
 *    for tests is a worse trade than a rare re-run.
 *
 * 2. The open thread's `window_expires_at`. A conversation cannot be both
 *    permanently open and described by a fixed instant — a literal in the
 *    future becomes a literal in the past, and the composer this fixture
 *    exists to photograph closes for good on a date nobody wrote down.
 *
 *    So it is `now() + 18 hours`, while `last_inbound_at`, `last_message_at`
 *    and the preview beside them stay literal, because those are what the
 *    inbox prints. The consequence, for whoever builds that page: render the
 *    window as the open/closed state it decides, or as a bucket coarse enough
 *    that the minutes between this script and the screenshot cannot move it.
 *    Never as a time. The closed thread is entirely literal and needs none of
 *    this — a window that expired stays expired.
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

  /* When each number last agreed with Meta, and when Meta stopped returning
     the second one. Three days apart so "refreshed" and "missing since" are
     visibly different dates rather than two readings of the same moment. */
  numberRefreshed: "2026-08-14T19:45:00Z", //  15/08/2026 01:15:00
  numberRefreshedOld: "2026-08-11T19:45:00Z", // 12/08/2026 01:15:00
  numberMissingSince: "2026-08-12T19:45:00Z", // 13/08/2026 01:15:00
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

/**
 * The webhook path Meta posts to, per integration.
 *
 * Pinned, where every other seeded row lets the column default. `webhook_key`
 * defaults to a database expression — a fresh random 32-hex value on every
 * INSERT — which was invisible for as long as nothing rendered it. Configuration
 * > Numbers renders it, and a random string on a photographed page is a baseline
 * that never matches twice.
 *
 * Same 32-hex shape the default produces, so nothing downstream can tell these
 * apart from a real one.
 */
const WEBHOOK_KEY = {
  [INTEGRATION.sheets]: "c8a15d7302e94b61af53d806e27b9145",
  [INTEGRATION.whatsapp]: "9f2c41a7b06d4e58a3d17c9e5b820f36",
  [INTEGRATION.otherCompany]: "4b7e0d93c1a84f26b5e8a07d3f19c254",
  [INTEGRATION.thirdCompany]: "1d6b83f5407c42e9b0a75c14e83f9d27",
};

/* ------------------------------------------------------------------ */
/* WhatsApp: numbers, contacts, threads                                */
/* ------------------------------------------------------------------ */

/**
 * Three numbers, three states.
 *
 * The same reasoning as the integrations below, one table over: a page that
 * only ever photographs a healthy row never photographs what an operator
 * actually opens it to look at.
 *
 *   01  the happy row, and the number both threads hang off.
 *   02  quality degraded AND absent from Meta's list since the day after it
 *       was last read. Not a contradiction — that is precisely what
 *       missing_since is for: the cache is frozen at what Meta last said,
 *       and the row survives so the absence has an age.
 *   03  a status this build does not model, which must render as itself
 *       rather than be flattened into UNKNOWN (see 20260816100000), with no
 *       verified name and no refresh — so the "Never" branch and the
 *       unapproved-name fallback are both on screen.
 */
const NUMBERS = [
  {
    id: "c000visualfixturenumber01",
    phoneNumberId: "109384756201847",
    displayNumber: "+91 98765 43210",
    verifiedName: "Northwind Traders",
    quality: "GREEN",
    status: "CONNECTED",
    tier: "TIER_1K",
    throughput: "STANDARD",
    refreshedAt: T.numberRefreshed,
    missingSince: null,
  },
  {
    id: "c000visualfixturenumber02",
    phoneNumberId: "109384756201848",
    displayNumber: "+91 98765 43211",
    verifiedName: "Northwind Support",
    quality: "YELLOW",
    status: "FLAGGED",
    tier: "TIER_250",
    throughput: "STANDARD",
    refreshedAt: T.numberRefreshedOld,
    missingSince: T.numberMissingSince,
  },
  {
    id: "c000visualfixturenumber03",
    phoneNumberId: "109384756201849",
    displayNumber: "+91 98765 43212",
    verifiedName: null,
    quality: "UNKNOWN",
    status: "UNVERIFIED",
    tier: null,
    throughput: null,
    refreshedAt: null,
    missingSince: null,
  },
];

/* The code the refresh job writes. A literal rather than an import: reaching
   @whatsapp-os/db for it pulls in client.ts, which parses env — and ESM
   evaluates that above the redirect at the top of this file. The constant is
   MISSING_FROM_META_LIST in packages/db/src/numbers.ts. */
const MISSING_FROM_META_LIST = "absent_from_meta_list";

/**
 * Two contacts on number 01, so the inbox has two threads and not one person
 * twice — @@unique(company_id, contact_id, whatsapp_number_id) means one
 * contact with two threads would have to be two different numbers.
 *
 * Anita has a profile name and nothing else; Vikram has a display name
 * somebody here typed, which wins. Both branches of the name resolution.
 */
const CONTACTS = [
  {
    id: "c000visualfixturecontact1",
    waId: "919812345690",
    phoneE164: "+919812345690",
    profileName: "Anita Desai",
    displayName: null,
  },
  {
    id: "c000visualfixturecontact2",
    waId: "919812345691",
    phoneE164: "+919812345691",
    profileName: "Vikram Shah",
    displayName: "Vikram (Ashgrove PO)",
  },
];

const MEDIA_ID = "c000visualfixturemedia001";

/**
 * A real 1x1 PNG, not a placeholder blob.
 *
 * Small enough to sit in the source and still be a file a browser will decode,
 * which matters: the thread renders it through /api/media/[mediaId] with a
 * content type and an ETag, and a byte string that is not an image would fail
 * there and nowhere else.
 *
 * The hash is computed rather than pasted. It is the row's identity, the
 * route's ETag and half of the (company_id, sha256) unique, and a CHECK
 * constraint ties byte_size to octet_length(bytes) — so a pasted value that
 * drifted would be three wrong things at once.
 */
const MEDIA_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const MEDIA_SHA256 = createHash("sha256").update(MEDIA_BYTES).digest("hex");

const CONVERSATION = {
  /* The open one. FIXTURE.conversationId, because the walker in pages.spec.ts
     substitutes it for [conversationId] and the thread page will be its URL. */
  open: FIXTURE.conversationId,
  closed: "c000visualfixtureconvo02",
};

/**
 * Two threads, and between them every state the next three commits render.
 *
 * Open: unanswered, two unread, the window still running. Closed: the window
 * expired on the 10th, and the outbound that went out on the 11th was refused
 * by Meta for exactly that reason — 131047 is the error a closed window
 * produces, so the thread tells one coherent story rather than carrying a
 * failure that could not have happened.
 *
 * The image is INBOUND. Outbound media is deferred to Phase 5 (P4) and the
 * composer renders a disabled attach control saying so, so a seeded outbound
 * image would be a fixture for a feature that does not exist.
 */
const MESSAGES = [
  {
    id: "c000visualfixturemessage1",
    conversationId: CONVERSATION.open,
    direction: "INBOUND",
    status: "DELIVERED",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkwFQIAEhggMEExRkIzM0M0NUE2N0Q4OQA=",
    body: "Hi — do you still have the 5kg pack of the Assam CTC?",
    occurredAt: "2026-08-14T09:02:11Z", // 14/08/2026 14:32:11
    sentBy: null,
  },
  {
    id: "c000visualfixturemessage2",
    conversationId: CONVERSATION.open,
    direction: "OUTBOUND",
    status: "READ",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkwFQIAERgSN0QyQTkxMEY4QjRDNjEyRDIA",
    body: "We do — 5kg is ₹1,240 including delivery. Shall I reserve one?",
    occurredAt: "2026-08-14T09:05:40Z", // 14/08/2026 14:35:40
    sentBy: "c000visualfixtureuser001",
  },
  {
    id: "c000visualfixturemessage3",
    conversationId: CONVERSATION.open,
    direction: "INBOUND",
    status: "DELIVERED",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkwFQIAEhggQjc1RTBEMjE5QThDNDRGMQA=",
    body: "Yes please. Same address as last time.",
    occurredAt: "2026-08-14T09:11:03Z", // 14/08/2026 14:41:03
    sentBy: null,
  },
  {
    id: "c000visualfixturemessage4",
    conversationId: CONVERSATION.open,
    direction: "INBOUND",
    status: "DELIVERED",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkwFQIAEhggRjMwOEM2QTdEMTJCNEU4NQA=",
    body: "And can you add two of the jaggery blocks?",
    occurredAt: "2026-08-14T09:12:58Z", // 14/08/2026 14:42:58
    sentBy: null,
  },

  {
    id: "c000visualfixturemessage5",
    conversationId: CONVERSATION.closed,
    direction: "INBOUND",
    status: "DELIVERED",
    type: "image",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkxFQIAEhggMkU5QjRDMDdBNjFEMzhBNwA=",
    body: "Purchase order for August.",
    mediaId: MEDIA_ID,
    occurredAt: "2026-08-09T05:30:00Z", // 09/08/2026 11:00:00
    sentBy: null,
  },
  {
    id: "c000visualfixturemessage6",
    conversationId: CONVERSATION.closed,
    direction: "OUTBOUND",
    status: "DELIVERED",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkxFQIAERgSQTFDNUY4M0IyRDdFNDA5NkEA",
    body: "Received — I'll confirm the dispatch date by Monday.",
    occurredAt: "2026-08-09T05:41:12Z", // 09/08/2026 11:11:12
    sentBy: "c000visualfixtureuser001",
  },
  {
    /* Sent a day after the window closed, and refused for that reason. The
       failed bubble and its retry action are commit 31; the row is here
       because it belongs to this thread's story and not to that commit. */
    id: "c000visualfixturemessage7",
    conversationId: CONVERSATION.closed,
    direction: "OUTBOUND",
    status: "FAILED",
    type: "text",
    wamid: "wamid.HBgMOTE5ODEyMzQ1NjkxFQIAERgSNkI4RDIwRTRDOTFBNzUzM0YA",
    body: "Dispatch is confirmed for Tuesday the 12th.",
    occurredAt: "2026-08-11T06:15:00Z", // 11/08/2026 11:45:00
    failedAt: "2026-08-11T06:15:03Z",
    errorSource: "META",
    errorCode: 131047,
    errorTitle:
      "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
    sentBy: "c000visualfixtureuser001",
  },
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
  const missing = [
    "companies",
    "integrations",
    "usage_events",
    "admin_users",
    "whatsapp_numbers",
    "contacts",
    "conversations",
    "messages",
    "whatsapp_media",
  ].filter((table) => !tables.has(table));

  if (missing.length > 0) {
    console.error(
      `${TEST_DATABASE_NAME} is missing ${missing.join(", ")}.\n` +
        "Run `npm run db:test:setup` first — this script seeds, it does not migrate.",
    );
    process.exit(1);
  }

  /*
   * Discovered, not listed.
   *
   * This was a hand-written list of fifteen tables, and Phase 4a added seven it
   * did not know about — which is the failure truncateAll in
   * packages/db/tests/helpers.ts already describes: a hardcoded list silently
   * stops covering the next table someone adds, and the residue turns up as a
   * confusing failure somewhere unrelated. Here it would be worse than
   * confusing: a fixture that does not wipe is a fixture that accumulates, and
   * every baseline drifts one run at a time.
   *
   * CASCADE handles the ordering, so the set does not need to be dependency
   * sorted. _prisma_migrations is excluded for the obvious reason.
   */
  const wipe = present
    .map((row) => row.tablename)
    .filter((table) => table !== "_prisma_migrations")
    .map((table) => `"${table}"`)
    .join(", ");

  await client.query(`TRUNCATE TABLE ${wipe} RESTART IDENTITY CASCADE`);

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
  /* webhook_key is named rather than left to the column default, which is a
     fresh random value on every INSERT. See WEBHOOK_KEY above. */
  await client.query(
    `INSERT INTO integrations (id, company_id, provider, label, status,
                               last_verified_at, last_error, webhook_key,
                               created_at, updated_at)
     VALUES ($1, $5, 'GOOGLE_SHEETS',  'Order sheet',      'CONNECTED',     $6, NULL, $11, $8, $8),
            ($2, $5, 'WHATSAPP_CLOUD', 'Primary number',   'CONNECTED',     $6, NULL, $12, $8, $8),
            ($3, $9, 'WHATSAPP_CLOUD', 'Support number',   'NOT_CONNECTED', $7,
             'Meta Graph API returned 190: Error validating access token.', $13, $8, $8),
            ($4, $10, 'GOOGLE_SHEETS', 'Consignment log',  'CONNECTED',     $6, NULL, $14, $8, $8)`,
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
      WEBHOOK_KEY[INTEGRATION.sheets],
      WEBHOOK_KEY[INTEGRATION.whatsapp],
      WEBHOOK_KEY[INTEGRATION.otherCompany],
      WEBHOOK_KEY[INTEGRATION.thirdCompany],
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

  /* ---------------------------------------------------------------- */
  /* WhatsApp                                                          */
  /* ---------------------------------------------------------------- */

  for (const number of NUMBERS) {
    await client.query(
      `INSERT INTO whatsapp_numbers (id, company_id, integration_id, phone_number_id,
                                     display_number, verified_name, quality_rating,
                                     status, messaging_tier, throughput_level,
                                     metadata_refreshed_at, missing_since,
                                     missing_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::whatsapp_quality_rating, $8, $9, $10,
               $11, $12, $13, $14, $14)`,
      [
        number.id,
        COMPANY.active,
        INTEGRATION.whatsapp,
        number.phoneNumberId,
        number.displayNumber,
        number.verifiedName,
        number.quality,
        number.status,
        number.tier,
        number.throughput,
        number.refreshedAt,
        number.missingSince,
        number.missingSince ? MISSING_FROM_META_LIST : null,
        T.companyCreated,
      ],
    );
  }

  for (const contact of CONTACTS) {
    await client.query(
      `INSERT INTO contacts (id, company_id, wa_id, phone_e164, profile_name,
                             display_name, opted_out_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7)`,
      [
        contact.id,
        COMPANY.active,
        contact.waId,
        contact.phoneE164,
        contact.profileName,
        contact.displayName,
        T.companyCreated,
      ],
    );
  }

  await client.query(
    `INSERT INTO whatsapp_media (id, company_id, sha256, mime_type, file_name,
                                 byte_size, state, skipped_reason,
                                 storage_backend, storage_key, bytes,
                                 created_at, updated_at)
     VALUES ($1, $2, $3, 'image/png', 'purchase-order-august.png', $4,
             'STORED'::media_state, NULL, 'postgres', NULL, $5, $6, $6)`,
    [
      MEDIA_ID,
      COMPANY.active,
      MEDIA_SHA256,
      MEDIA_BYTES.length,
      MEDIA_BYTES,
      T.companyCreated,
    ],
  );

  /*
   * The open thread's window is the only value here the clock decides — see
   * the note at the top of this file, and do not render it as a time.
   *
   * The closed one expired on 10/08 and stays expired, which is what makes the
   * refusal on message 7 the truth rather than a decorative error.
   */
  await client.query(
    `INSERT INTO conversations (id, company_id, contact_id, whatsapp_number_id,
                                source, last_inbound_at, last_message_at,
                                last_message_preview, window_expires_at,
                                unread_count, assigned_user_id, assigned_at,
                                created_at, updated_at)
     VALUES ($1, $3, $4, $6, 'INBOUND'::conversation_source, $7, $7, $8,
             now() + interval '18 hours', 2, NULL, NULL, $7, $7),
            ($2, $3, $5, $6, 'INBOUND'::conversation_source, $9, $10, $11,
             $12, 0, $13, $10, $9, $9)`,
    [
      CONVERSATION.open,
      CONVERSATION.closed,
      COMPANY.active,
      CONTACTS[0].id,
      CONTACTS[1].id,
      NUMBERS[0].id,
      "2026-08-14T09:12:58Z",
      "And can you add two of the jaggery blocks?",
      "2026-08-09T05:30:00Z",
      "2026-08-11T06:15:00Z",
      "Dispatch is confirmed for Tuesday the 12th.",
      "2026-08-10T05:30:00Z" /* 24h after the last inbound. Closed. */,
      "c000visualfixtureuser001",
    ],
  );

  for (const message of MESSAGES) {
    await client.query(
      `INSERT INTO messages (id, company_id, conversation_id, direction, status,
                             type, wamid, body, media_id, error_source,
                             error_code, error_title, send_attempt,
                             sent_by_user_id, occurred_at, delivered_at,
                             read_at, failed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4::message_direction, $5::message_status, $6, $7, $8,
               $9, $10::message_failure_source, $11, $12, 0, $13, $14,
               $15, $16, $17, $14, $14)`,
      [
        message.id,
        COMPANY.active,
        message.conversationId,
        message.direction,
        message.status,
        message.type,
        message.wamid,
        message.body,
        message.mediaId ?? null,
        message.errorSource ?? null,
        message.errorCode ?? null,
        message.errorTitle ?? null,
        message.sentBy,
        message.occurredAt,
        /* The ladder, spelled out rather than derived: a DELIVERED row has a
           delivered_at, a READ row has both, and a FAILED row has neither and
           a failed_at instead. A thread rendering ticks from these columns
           would otherwise photograph a state no real message can be in. */
        message.status === "FAILED" ? null : message.occurredAt,
        message.status === "READ" ? message.occurredAt : null,
        message.failedAt ?? null,
      ],
    );
  }

  console.log(
    `Seeded ${TEST_DATABASE_NAME}: 3 companies, ${users.length} users, ` +
      `4 integrations, ${secretId} secrets, ${verifications.length} verifications, ` +
      `${USAGE.length} usage events, ${NUMBERS.length} WhatsApp numbers, ` +
      `${CONTACTS.length} contacts, 2 conversations, ${MESSAGES.length} messages, ` +
      `1 media row.`,
  );
} finally {
  await client.end();
}

process.exit(0);
