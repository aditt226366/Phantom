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
  /*
   * A verified workspace with nothing in it - which is what every tenant sees
   * on their first day, and the state least likely to be looked at while a
   * feature is being built, because the machine it is built on always has data.
   *
   * Deliberately not the same thing as the UNVERIFIED workspace beside it.
   * That one photographs the KYC gate; this one photographs the dashboard's
   * own empty states, which are a different set of branches entirely - no
   * rates, no ladder, no donut, and six action cards each saying what will
   * appear in it.
   */
  fresh: FIXTURE.freshCompanyId,
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
 *
 * Anita's is long on purpose, and it is not padding. R4 names `profileName`
 * and `lastMessagePreview` as the two automatic-minimum-size hazards in the
 * inbox — customer-supplied strings of no bounded length, which is the exact
 * shape of both faults this screenshot suite has ever caught. A fixture whose
 * names all fit photographs a page where the mitigation was never needed and
 * therefore never tested. People do put their shop in their WhatsApp profile.
 */
const CONTACTS = [
  {
    id: "c000visualfixturecontact1",
    waId: "919812345690",
    phoneE164: "+919812345690",
    profileName: "Anita Desai — Sunrise Provision Stores, Andheri East",
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

/* The sentence the thread shows when nobody knows what happened. A literal
   with a comment rather than an import, for the reason MISSING_FROM_META_LIST
   above gives: reaching @whatsapp-os/db pulls in client.ts, which parses env,
   and ESM evaluates that above the redirect at the top of this file. The
   constant is DELIVERY_UNKNOWN_TITLE in packages/db/src/send.ts. */
const DELIVERY_UNKNOWN_TITLE =
  "Delivery unknown - Meta did not answer. Check WhatsApp before sending again; " +
  "retrying may send this message twice.";

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

/* ------------------------------------------------------------------ */
/* Lead sources                                                        */
/* ------------------------------------------------------------------ */

/**
 * Two bindings, and the second one is the reason this block exists.
 *
 *   healthy    polling, with real leads behind it in three different states,
 *              so the live feed photographs more than one badge.
 *   lost       ERROR, carrying the sentence Google actually produces when a
 *              spreadsheet was never shared with the service account.
 *
 * The error state is the screen a tenant genuinely stares at and the one least
 * likely to be looked at during development, because everything works on the
 * machine where the share was set up by the person writing the feature. It is
 * seeded deliberately for that reason - the same argument as the unverified
 * workspace one table over.
 */
const LEAD_SOURCE = {
  healthy: "c000visualfixtureleadsrc1",
  lost: "c000visualfixtureleadsrc2",
};

const LEAD_MAPPING = {
  phone: "Mobile",
  variables: { 1: "Name", 2: "Order" },
};

/** Literal instants, because the binding prints when it last looked and sent. */
const T_LEAD = {
  healthyCreated: "2026-08-12T05:00:00Z", // 12/08/2026 10:30:00
  healthyPolled: "2026-08-15T06:30:00Z", //  15/08/2026 12:00:00
  healthySent: "2026-08-15T06:29:00Z", //    15/08/2026 11:59:00
  lostCreated: "2026-08-11T04:00:00Z", //    11/08/2026 09:30:00
  lostPolled: "2026-08-15T06:31:00Z", //     15/08/2026 12:01:00
  lostFailed: "2026-08-13T09:15:00Z", //     13/08/2026 14:45:00
};

/**
 * The healthy binding's recent leads.
 *
 * One of each outcome the feed can show - delivered, queued, and a row skipped
 * because the contact had opted out. A feed of five identical green badges
 * would photograph a layout that has never had to fit a long sentence beside a
 * number, which is exactly the part that breaks at 390px.
 */
const LEAD_ROWS = [
  { phone: "+919876543240", state: "SENT", status: "READ", skip: null },
  { phone: "+919876543241", state: "SENT", status: "DELIVERED", skip: null },
  { phone: "+919876543242", state: "SENT", status: "SENT", skip: null },
  { phone: "+919876543243", state: "SENT", status: "PENDING", skip: null },
  {
    phone: "+919876543244",
    state: "SKIPPED",
    status: null,
    skip: "Opted out, or the number cannot receive WhatsApp",
  },
  {
    phone: "+919876543245",
    state: "SENT",
    status: "FAILED",
    skip: null,
    error: "This number cannot receive WhatsApp messages.",
  },
];

/* ------------------------------------------------------------------ */

/* Broadcasts                                                          */
/* ------------------------------------------------------------------ */

/**
 * Three broadcasts, because the interesting screens are three different
 * states of one page and a suite that photographs only a clean send never
 * shows the screen an operator actually stares at.
 *
 *   draft      still in the wizard - the mapping and confirm steps render
 *              from its source_rows, which only a draft still has.
 *   running    part way through, with recipients in every stage at once.
 *   finished   completed AND carrying real failures, grouped by reason.
 *
 * The failure rows are the point of the third one. A report with nothing in
 * the "why messages failed" section is a report nobody has ever had to read,
 * and the layout of that section - a long sentence beside a big number - is
 * exactly the part most likely to be wrong at 390px.
 */
const BROADCAST = {
  draft: "c000visualfixturebcast001",
  running: "c000visualfixturebcast002",
  finished: "c000visualfixturebcast003",
};

/**
 * The uploaded file, as papaparse would hand it back.
 *
 * Literal, and deliberately imperfect: row three has no number at all, so the
 * confirm screen photographs a non-zero "no usable number" count rather than
 * four clean zeroes that tell a reader nothing about what the screen does when
 * a list is messy.
 */
const BROADCAST_SOURCE_HEADERS = ["Name", "Mobile", "Order"];

const BROADCAST_SOURCE_ROWS = [
  { Name: "Anita Desai", Mobile: "98765 43210", Order: "NW-2291" },
  { Name: "Vikram Shah", Mobile: "+91 98765 43211", Order: "NW-2288" },
  { Name: "Rahul Nair", Mobile: "", Order: "NW-2284" },
  { Name: "Fatima Sheikh", Mobile: "98765 43213", Order: "NW-2280" },
  { Name: "Joseph Mathew", Mobile: "98765 43214", Order: "NW-2277" },
];

const BROADCAST_MAPPING = {
  phone: "Mobile",
  variables: { 1: "Name", 2: "Order" },
};

/** Literal instants, because the report prints started and finished. */
const T_BROADCAST = {
  draftCreated: "2026-08-15T04:30:00Z", //    15/08/2026 10:00:00
  runningCreated: "2026-08-14T05:00:00Z", //  14/08/2026 10:30:00
  runningStarted: "2026-08-14T05:02:00Z", //  14/08/2026 10:32:00
  finishedCreated: "2026-08-13T04:15:00Z", // 13/08/2026 09:45:00
  finishedStarted: "2026-08-13T04:20:00Z", // 13/08/2026 09:50:00
  finishedEnded: "2026-08-13T05:05:00Z", //   13/08/2026 10:35:00
};

/**
 * The finished broadcast's recipients, and what became of each.
 *
 * Two distinct failure reasons with different counts, so the grouped list
 * renders more than one row and a version that printed the same number twice
 * would be visibly wrong rather than plausibly right. The sentences are the
 * real ones - describeRefusal's and Meta's - so the report photographs what a
 * tenant would actually read.
 */
const FINISHED_RECIPIENTS = [
  { phone: "+919876543220", status: "READ", error: null },
  { phone: "+919876543221", status: "READ", error: null },
  { phone: "+919876543222", status: "DELIVERED", error: null },
  { phone: "+919876543223", status: "DELIVERED", error: null },
  { phone: "+919876543224", status: "DELIVERED", error: null },
  { phone: "+919876543225", status: "SENT", error: null },
  /*
   * The three failures carry Meta's own codes, and did not until Phase 9.
   *
   * The titles were already Meta's wording for specific errors - "cannot
   * receive WhatsApp messages" IS 131026 - so a row with that sentence and a
   * null code was a fixture describing a message that could not exist. Nothing
   * read the column until the dashboard grouped failures by it, at which point
   * the gap became visible: a breakdown reporting every failure as "other"
   * while the titles beside it named two distinct causes.
   *
   * 131049 replaces one of the two duplicates rather than being added as a
   * fourth row. The delivery-limited case is the one that means the NUMBER is
   * in trouble rather than the recipient, it is the reason the dashboard
   * separates it at all, and a fixture with two identical failures was spending
   * a row on a case it had already made.
   */
  {
    phone: "+919876543226",
    status: "FAILED",
    code: 131026,
    error: "This number cannot receive WhatsApp messages.",
  },
  {
    phone: "+919876543227",
    status: "FAILED",
    code: 131049,
    error: "Meta did not deliver this message: the recipient has reached their limit for marketing messages.",
  },
  {
    phone: "+919876543228",
    status: "FAILED",
    code: 131047,
    error: "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
  },
];

/** The running one: some sent, some delivered, the rest still queued. */
const RUNNING_RECIPIENTS = [
  { phone: "+919876543230", status: "DELIVERED" },
  { phone: "+919876543231", status: "DELIVERED" },
  { phone: "+919876543232", status: "SENT" },
  { phone: "+919876543233", status: "SENT" },
  { phone: "+919876543234", status: null },
  { phone: "+919876543235", status: null },
  { phone: "+919876543236", status: null },
];

/* ------------------------------------------------------------------ */
/* KYC documents                                                       */
/* ------------------------------------------------------------------ */

/**
 * A real, minimal PDF - not a placeholder blob.
 *
 * It has to open with %PDF- because a CHECK constraint says so, and it has to
 * be something a browser will actually render because the admin tab serves it
 * inline through an authenticated route. The trailing EOF marker is what makes
 * it a complete file rather than five convincing bytes.
 *
 * The hash is computed rather than pasted: it is the download route's ETag and
 * a CHECK constraint ties byte_size to octet_length(bytes), so a stale literal
 * would be two wrong things at once.
 */
const KYC_PDF_BYTES = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
    "",
  ].join("\n"),
  "latin1",
);

/**
 * The fixture company is fully verified, and that is load-bearing.
 *
 * A4 blocks every feature section until all three are approved, so without
 * these rows every tenant page in the suite photographs a blocked state and
 * every baseline moves. The gate arrived on the send path first - canSend
 * consults it - which is why these land here rather than with the enforcement
 * commit.
 *
 * Literal instants, because Profile > Documents renders each upload date and
 * each decision date. This is the ordinary case of the rule at the top of the
 * file: a value that is printed must not come from the clock.
 *
 * All three approved by the seeded operator, so reviewed_by_admin_id is a real
 * row rather than null - the admin tab reads it, and a fixture that left it
 * null would photograph the branch nobody sees in production.
 */
const KYC_DOCUMENTS = [
  {
    id: "c000visualfixturekyc00001",
    kind: "GST",
    filename: "northwind-gst-certificate.pdf",
    uploadedAt: "2026-02-11T05:10:00Z", // 11/02/2026 10:40:00
    reviewedAt: "2026-02-12T06:20:00Z", // 12/02/2026 11:50:00
  },
  {
    id: "c000visualfixturekyc00002",
    kind: "PAN",
    filename: "northwind-pan-card.pdf",
    uploadedAt: "2026-02-11T05:12:00Z", // 11/02/2026 10:42:00
    reviewedAt: "2026-02-12T06:21:00Z", // 12/02/2026 11:51:00
  },
  {
    id: "c000visualfixturekyc00003",
    kind: "AADHAAR",
    filename: "priya-menon-aadhaar.pdf",
    uploadedAt: "2026-02-11T05:15:00Z", // 11/02/2026 10:45:00
    reviewedAt: "2026-02-12T06:22:00Z", // 12/02/2026 11:52:00
  },
];

/**
 * The unverified workspace, in the three states a tenant can be in at once.
 *
 * This is the fixture for the blocked shell, and it is deliberately NOT "no
 * documents at all". Every branch the documents page has is on screen in one
 * picture: an approved row with its upload control hidden, a rejected row
 * carrying the reason a tenant has to read, and a kind never sent - which is
 * the only one of the three that renders an empty upload control.
 *
 * The mix also drives the gate to `documents_rejected` rather than
 * `documents_missing`, which is the reason ordering worth photographing: a
 * tenant who has filed two of three and been refused one is the person most
 * likely to think they are simply waiting.
 *
 * Ashgrove Logistics rather than the deactivated company, because a suspended
 * workspace would report `company_deactivated` and photograph the one blocked
 * state that has nothing to do with documents.
 */
const BLOCKED_KYC_DOCUMENTS = [
  {
    id: "c000visualfixturekyc00011",
    kind: "GST",
    filename: "ashgrove-gst-certificate.pdf",
    status: "APPROVED",
    uploadedAt: "2026-08-20T05:10:00Z", // 20/08/2026 10:40:00
    reviewedAt: "2026-08-21T06:20:00Z", // 21/08/2026 11:50:00
    reviewNote: null,
  },
  {
    id: "c000visualfixturekyc00012",
    kind: "PAN",
    filename: "ashgrove-pan-scan.pdf",
    status: "REJECTED",
    uploadedAt: "2026-08-20T05:12:00Z", // 20/08/2026 10:42:00
    reviewedAt: "2026-08-21T06:24:00Z", // 21/08/2026 11:54:00
    /* A real reason, saying what to do next. A fixture whose rejection note
       reads "rejected" would photograph the failure this page exists to
       prevent - a refusal the tenant cannot act on. */
    reviewNote:
      "The bottom edge of the card is cut off, so the number is not fully readable. Please send a scan of the whole card.",
  },
  /* AADHAAR is deliberately absent: the not-uploaded branch. */
];

const CONVERSATION = {
  /* The open one. FIXTURE.conversationId, because the walker in pages.spec.ts
     substitutes it for [conversationId] and the thread page will be its URL. */
  open: FIXTURE.conversationId,
  closed: FIXTURE.closedConversationId,
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
    body:
      "And can you add two of the jaggery blocks to the same order, the 500g ones if you have them in stock?",
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
    /*
     * No wamid, and that is the whole difference between this and a message
     * that failed downstream. Meta rejects a closed-window send on the POST
     * itself, so recordSendRefused runs and never names the message - which is
     * what makes non-delivery proven here and a retry safe to offer plainly.
     */
    wamid: null,
    body: "Dispatch is confirmed for Tuesday the 12th.",
    occurredAt: "2026-08-11T06:15:00Z", // 11/08/2026 11:45:00
    failedAt: "2026-08-11T06:15:03Z",
    errorSource: "META",
    errorCode: 131047,
    errorTitle:
      "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
    sentBy: "c000visualfixtureuser001",
  },
  {
    /*
     * Meta never answered. Sent while the window was still open, between the
     * customer's file and the reply that did land, so the thread stays
     * coherent - and it puts the one status nothing can ever resolve on a page
     * the suite photographs. Only a person can close this out; there is no
     * wamid, so no callback can ever match the row.
     */
    id: "c000visualfixturemessage8",
    conversationId: CONVERSATION.closed,
    direction: "OUTBOUND",
    status: "UNCONFIRMED",
    type: "text",
    wamid: null,
    body: "Thanks — checking stock on those now.",
    occurredAt: "2026-08-09T05:35:00Z", // 09/08/2026 11:05:00
    /* error_source stays null: nobody refused this. A populated title beside a
       null source is the shape that means "no verdict". */
    errorTitle: DELIVERY_UNKNOWN_TITLE,
    sentBy: "c000visualfixtureuser001",
  },
];

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * One approved and one rejected, and the rejected one is the point.
 *
 * Meta's rejection reason is the copy in this product most likely to be wrong
 * and least likely to be looked at: it arrives as a machine token, it appears
 * on a screen nobody visits until something has already gone wrong, and by then
 * the person reading it is trying to fix something. So it is in the fixture,
 * photographed, with a real token rather than a sentence somebody invented.
 *
 * The rejection is also internally true. `weekend_offer` opens on a variable,
 * which is one of the three rules validateTemplate enforces and one of the
 * things Meta actually rejects for — so INVALID_FORMAT is the reason its own
 * body earns. The fixture and the validator describe the same rule from
 * opposite ends.
 *
 * The approved one carries {{1}} and {{2}} deliberately. Any approved template
 * with variables needs values typed at send time, so a fixture whose only
 * template is variable-free would photograph a picker with nothing to fill in.
 */
const TEMPLATES = [
  {
    id: FIXTURE.approvedTemplateId,
    name: "order_shipped",
    language: "en_US",
    category: "UTILITY",
    status: "APPROVED",
    metaTemplateId: "1094857362019283",
    rejectedReason: null,
    statusUpdatedAt: "2026-08-12T06:15:00Z", // 12/08/2026 11:45:00
    components: [
      { type: "HEADER", format: "TEXT", text: "Your order is on its way" },
      {
        type: "BODY",
        text: "Hi {{1}}, order {{2}} has left our warehouse and should reach you in two working days.",
        example: { body_text: [["Anita", "NW-2291"]] },
      },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Track it" },
          { type: "QUICK_REPLY", text: "Talk to us" },
        ],
      },
    ],
    /* Two edits, so the quota renders a number rather than a zero - and a
       number well under the limit, so the "edits made here" label is doing its
       job rather than sitting beside an exhausted allowance. */
    edits: 2,
  },
  {
    id: FIXTURE.rejectedTemplateId,
    name: "weekend_offer",
    language: "en_US",
    category: "MARKETING",
    status: "REJECTED",
    metaTemplateId: "1094857362019284",
    /* Meta's own token. Rendered verbatim beside a plain-English explanation -
       never replaced by one, because the token is what their support asks for. */
    rejectedReason: "INVALID_FORMAT",
    statusUpdatedAt: "2026-08-13T07:40:00Z", // 13/08/2026 13:10:00
    components: [
      {
        type: "BODY",
        text: "{{1}}, this weekend only: 20% off everything in store.",
        example: { body_text: [["Anita"]] },
      },
    ],
    edits: 1,
  },
  {
    /*
     * Adopted from Meta rather than built here, which is what the Library tab
     * shows. createdBy stays null - that is the marker, and it is also the
     * truth: nobody in this workspace wrote it.
     */
    id: "c000visualfixturetmpl003",
    name: "appointment_reminder",
    language: "en_US",
    category: "UTILITY",
    status: "APPROVED",
    metaTemplateId: "1094857362019285",
    rejectedReason: null,
    statusUpdatedAt: "2026-08-10T09:00:00Z", // 10/08/2026 14:30:00
    components: [
      {
        type: "BODY",
        text: "Reminder: your appointment with us is on {{1}} at {{2}}. Reply RESCHEDULE if you need a different time.",
        example: { body_text: [["Thursday", "3pm"]] },
      },
    ],
    createdBy: null,
    edits: 0,
  },
];

/**
 * Threads whose 24-hour window shuts inside the dashboard's horizon.
 *
 * ---------------------------------------------------------------------------
 * The one place this file seeds FROM the clock, and why that is the stable
 * choice rather than the risky one
 * ---------------------------------------------------------------------------
 *
 * The rule at the top of this file is that a rendered value must be a literal.
 * The rule it serves is that a rendered value must not CHANGE between runs -
 * and for a duration those two pull in opposite directions. A literal
 * `window_expires_at` is a fixed instant whose distance from now grows every
 * day, so the card would read "Under 15 min" today and "closed" tomorrow.
 *
 * Seeding relative to now() inverts it: the stored value moves and the rendered
 * value is fixed, which is what the baseline needs. The open thread above
 * already does exactly this for the same column and says so.
 *
 * The offsets are chosen with slack. The dashboard renders a coarse bucket -
 * under 15, under 30, within the hour - so 8, 22 and 50 minutes each sit
 * several minutes clear of a boundary, and a slow run between the seed and the
 * capture cannot move one into the next bucket.
 */
const CLOSING_THREADS = [
  {
    id: "c000visualfixtureclosing1",
    contactId: "c000visualfixtureclosect1",
    waId: "919812345693",
    phone: "+919812345693",
    name: "Devika Rao",
    minutes: 8,
    lastMessageAt: "2026-08-08T05:30:00Z", // 08/08/2026 11:00:00
    preview: "Perfect, I will take the two-seater in the charcoal fabric.",
  },
  {
    id: "c000visualfixtureclosing2",
    contactId: "c000visualfixtureclosect2",
    waId: "919812345694",
    phone: "+919812345694",
    name: "Imran Shaikh",
    minutes: 22,
    lastMessageAt: "2026-08-07T05:30:00Z", // 07/08/2026 11:00:00
    preview: "Is the warranty transferable if I gift it?",
  },
  {
    id: "c000visualfixtureclosing3",
    contactId: "c000visualfixtureclosect3",
    waId: "919812345695",
    phone: "+919812345695",
    name: "Lakshmi Nair",
    minutes: 50,
    lastMessageAt: "2026-08-06T05:30:00Z", // 06/08/2026 11:00:00
    preview: "Sending the measurements now, one moment.",
  },
];

/**
 * A template Meta has not answered on, so the dashboard's queue is not empty.
 *
 * `created_at` is relative to now() for the reason above: the card renders how
 * long it has been waiting, and an age computed against a literal instant
 * drifts with the calendar - a baseline recorded today saying "3 days" says
 * "10 days" next week, and the suite fails for the passage of time rather than
 * for a change to the page.
 *
 * Three days is also the interesting value. Meta usually answers in minutes, so
 * a template three days old is the case the card exists to surface, and a
 * fixture showing "12 minutes" would photograph the state nobody needs to see.
 */
const PENDING_TEMPLATE = {
  id: "c000visualfixturetmpl004",
  name: "delivery_delayed",
  language: "en_US",
  category: "UTILITY",
  daysWaiting: 3,
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, order {{2}} is delayed by two days. We are sorry, and we will confirm the new date tomorrow.",
      example: { body_text: [["Anita", "NW-2291"]] },
    },
  ],
};

/**
 * The workspace with nothing in it: a company, an owner, and three approved
 * documents so the KYC gate opens onto an empty dashboard rather than a
 * blocked one.
 *
 * No integration, no number, no contact, no conversation, no template, no
 * usage event. Every one of those absences is a branch on the page.
 */
const FRESH = {
  userId: "c000visualfixtureuser006",
  fullName: "Arjun Verma",
  email: "arjun@cedarline.test",
  phone: "+919812345680",
  created: "2026-08-30T04:30:00Z", //  30/08/2026 10:00:00
  kyc: [
    ["c000visualfixturekyc00007", "GST", "cedarline-gst-certificate.pdf"],
    ["c000visualfixturekyc00008", "PAN", "cedarline-pan-card.pdf"],
    ["c000visualfixturekyc00009", "AADHAAR", "arjun-verma-aadhaar.pdf"],
  ],
  kycUploadedAt: "2026-08-30T05:10:00Z", // 30/08/2026 10:40:00
  kycReviewedAt: "2026-08-30T06:20:00Z", // 30/08/2026 11:50:00
};

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
    "whatsapp_templates",
    "whatsapp_template_edits",
    "companies",
    "integrations",
    "usage_events",
    "admin_users",
    "whatsapp_numbers",
    "contacts",
    "conversations",
    "messages",
    "whatsapp_media",
    "kyc_documents",
    "broadcasts",
    "broadcast_recipients",
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
            ($3, 'ashgrove-logistics', 'Ashgrove Logistics', 'ENTERPRISE', NULL, $7, $7),
            ($8, 'cedarline-interiors', 'Cedarline Interiors', 'STARTER', NULL, $9, $9)`,
    [
      COMPANY.active,
      COMPANY.deactivated,
      COMPANY.enterprise,
      T.companyCreated,
      T.deactivated,
      T.otherCreated,
      T.thirdCreated,
      COMPANY.fresh,
      FRESH.created,
    ],
  );

  const users = [
    ["c000visualfixtureuser001", COMPANY.active, "Priya Menon", "priya@northwind.test", "priya_menon", "OWNER", "+919812345670", T.ownerLastLogin],
    ["c000visualfixtureuser002", COMPANY.active, "Rohan Iyer", "rohan@northwind.test", "rohan_iyer", "MEMBER", "+919812345671", null],
    ["c000visualfixtureuser003", COMPANY.active, "Sana Qureshi", "sana@northwind.test", "sana_q", "MEMBER", "+919812345672", null],
    ["c000visualfixtureuser004", COMPANY.deactivated, "Dev Kapoor", "dev@brightleaf.test", "dev_kapoor", "OWNER", "+919812345673", T.otherLastLogin],
    ["c000visualfixtureuser005", COMPANY.enterprise, "Meera Raghavan", "meera@ashgrove.test", "meera_r", "OWNER", "+919812345674", null],
    /* The fresh workspace's owner. last_login_at is NULL and visual.setup.ts
       puts it back after signing in, because /admin/companies renders it. */
    [FRESH.userId, COMPANY.fresh, FRESH.fullName, FRESH.email, FIXTURE.freshTenant.username, "OWNER", FRESH.phone, null],
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
      "And can you add two of the jaggery blocks to the same order, the 500g ones if you have them in stock?",
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

  /* ---------------------------------------------------------------- */
  /* Templates                                                         */
  /* ---------------------------------------------------------------- */

  let templateEditId = 0;
  for (const template of TEMPLATES) {
    await client.query(
      `INSERT INTO whatsapp_templates
         (id, company_id, integration_id, name, language, category, components,
          status, meta_template_id, rejected_reason, status_updated_at,
          created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $13)`,
      [
        template.id,
        COMPANY.active,
        INTEGRATION.whatsapp,
        template.name,
        template.language,
        template.category,
        JSON.stringify(template.components),
        template.status,
        template.metaTemplateId,
        template.rejectedReason,
        template.statusUpdatedAt,
        template.createdBy === null ? null : "c000visualfixtureuser001",
        T.companyCreated,
      ],
    );

    /*
     * The edit log. Stamped `now()` minus a few days, which is the one place
     * this file lets the clock decide something and the rule at the top still
     * applies: the quota is a COUNT, never a rendered instant. A literal here
     * would age out of Meta's rolling thirty-day window and the count would
     * silently fall to zero on a date nobody wrote down.
     */
    for (let n = 0; n < template.edits; n++) {
      await client.query(
        `INSERT INTO whatsapp_template_edits
           (id, company_id, template_id, components, edited_by_user_id, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, now() - ($6 || ' days')::interval)`,
        [
          `c000visualfixturetedit${String(++templateEditId).padStart(2, "0")}`,
          COMPANY.active,
          template.id,
          JSON.stringify(template.components),
          "c000visualfixtureuser001",
          String(n + 1),
        ],
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* KYC documents                                                      */
  /* ---------------------------------------------------------------- */

  for (const document of KYC_DOCUMENTS) {
    await client.query(
      `INSERT INTO kyc_documents
         (id, company_id, kind, bytes, byte_size, sha256, mime_type,
          original_filename, status, reviewed_by_admin_id, reviewed_at,
          review_note, created_at)
       VALUES ($1, $2, $3::kyc_document_kind, $4, $5, $6, 'application/pdf',
               $7, 'APPROVED', 'c000visualfixtureadmin01', $8, NULL, $9)`,
      [
        document.id,
        COMPANY.active,
        document.kind,
        KYC_PDF_BYTES,
        KYC_PDF_BYTES.byteLength,
        createHash("sha256").update(KYC_PDF_BYTES).digest("hex"),
        document.filename,
        document.reviewedAt,
        document.uploadedAt,
      ],
    );
  }

  /* The fresh workspace is verified, so its dashboard is empty rather than
     blocked. Without these three every page it renders is the KYC gate, and
     the state this fixture exists to photograph is never reached. */
  for (const [id, kind, filename] of FRESH.kyc) {
    await client.query(
      `INSERT INTO kyc_documents
         (id, company_id, kind, bytes, byte_size, sha256, mime_type,
          original_filename, status, reviewed_by_admin_id, reviewed_at,
          review_note, created_at)
       VALUES ($1, $2, $3::kyc_document_kind, $4, $5, $6, 'application/pdf',
               $7, 'APPROVED', 'c000visualfixtureadmin01', $8, NULL, $9)`,
      [
        id,
        COMPANY.fresh,
        kind,
        KYC_PDF_BYTES,
        KYC_PDF_BYTES.byteLength,
        createHash("sha256").update(KYC_PDF_BYTES).digest("hex"),
        filename,
        FRESH.kycReviewedAt,
        FRESH.kycUploadedAt,
      ],
    );
  }

  for (const document of BLOCKED_KYC_DOCUMENTS) {
    await client.query(
      `INSERT INTO kyc_documents
         (id, company_id, kind, bytes, byte_size, sha256, mime_type,
          original_filename, status, reviewed_by_admin_id, reviewed_at,
          review_note, created_at)
       VALUES ($1, $2, $3::kyc_document_kind, $4, $5, $6, 'application/pdf',
               $7, $8::kyc_document_status, 'c000visualfixtureadmin01', $9,
               $10, $11)`,
      [
        document.id,
        COMPANY.enterprise,
        document.kind,
        KYC_PDF_BYTES,
        KYC_PDF_BYTES.byteLength,
        createHash("sha256").update(KYC_PDF_BYTES).digest("hex"),
        document.filename,
        document.status,
        document.reviewedAt,
        document.reviewNote,
        document.uploadedAt,
      ],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Broadcasts                                                         */
  /* ---------------------------------------------------------------- */

  /* The draft: still in the wizard, so it keeps its source rows. Only a draft
     has them - confirming a broadcast clears them, which is what the mapping
     and confirm pages 404 on for anything already sent. */
  await client.query(
    `INSERT INTO broadcasts
       (id, company_id, name, template_id, whatsapp_number_id, status,
        column_mapping, gap_ms, source_filename, source_rows, source_headers,
        parsed_count, invalid_count, duplicate_count, existing_count,
        opted_out_count, recipient_count, created_by_user_id, created_at,
        updated_at)
     VALUES ($1, $2, 'October offer list', $3, $4, 'DRAFT', $5::jsonb, 800,
             'october-customers.csv', $6::jsonb, $7::jsonb,
             5, 1, 0, 2, 0, 4, 'c000visualfixtureuser001', $8, $8)`,
    [
      BROADCAST.draft,
      COMPANY.active,
      FIXTURE.approvedTemplateId,
      NUMBERS[0].id,
      JSON.stringify(BROADCAST_MAPPING),
      JSON.stringify(BROADCAST_SOURCE_ROWS),
      JSON.stringify(BROADCAST_SOURCE_HEADERS),
      T_BROADCAST.draftCreated,
    ],
  );

  /*
   * A contact, a conversation and a message per recipient - because that is
   * exactly what a bulk recipient IS. Nothing here is a broadcast-shaped
   * parallel row; the seed writes the same three tables the inbox reads.
   */
  let broadcastMessageId = 0;

  async function seedBroadcastRun(input) {
    await client.query(
      `INSERT INTO broadcasts
         (id, company_id, name, template_id, whatsapp_number_id, status,
          column_mapping, gap_ms, source_filename, parsed_count, invalid_count,
          duplicate_count, existing_count, opted_out_count, recipient_count,
          created_by_user_id, started_at, finished_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::broadcast_status, $7::jsonb, 800, $8,
               $9, $10, 0, 0, 0, $11, 'c000visualfixtureuser001', $12, $13,
               $14, $14)`,
      [
        input.id,
        COMPANY.active,
        input.name,
        FIXTURE.approvedTemplateId,
        NUMBERS[0].id,
        input.status,
        JSON.stringify(BROADCAST_MAPPING),
        input.filename,
        input.recipients.length + input.invalid,
        input.invalid,
        input.recipients.length,
        input.startedAt,
        input.finishedAt,
        input.createdAt,
      ],
    );

    for (const [index, recipient] of input.recipients.entries()) {
      const waId = recipient.phone.slice(1);
      const contactId = `c000visualfixturebc${String(broadcastMessageId).padStart(6, "0")}`;
      const conversationId = `c000visualfixturebv${String(broadcastMessageId).padStart(6, "0")}`;
      const messageId = `c000visualfixturebm${String(broadcastMessageId).padStart(6, "0")}`;
      const recipientId = `c000visualfixturebr${String(broadcastMessageId).padStart(6, "0")}`;
      broadcastMessageId += 1;

      await client.query(
        `INSERT INTO contacts (id, company_id, wa_id, phone_e164, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [contactId, COMPANY.active, waId, recipient.phone, input.createdAt],
      );

      const sent = recipient.status !== null;
      const preview = `Hi Customer ${index + 1}, order NW-${2200 + index} has left our warehouse and should reach you in two working days.`;

      /*
       * last_message_at and the preview are set for a sent recipient, because
       * materialiseRecipient calls advanceConversation and that is what it
       * writes. A fixture that left them null photographed an inbox full of
       * "No preview" threads sorting above the customers who had actually
       * written in - which was a real bug in the send path, found by looking
       * at the picture. window_expires_at stays null on purpose: a template
       * does not open a 24-hour window.
       */
      await client.query(
        `INSERT INTO conversations
           (id, company_id, contact_id, whatsapp_number_id, unread_count,
            last_message_at, last_message_preview, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $7)`,
        [
          conversationId,
          COMPANY.active,
          contactId,
          NUMBERS[0].id,
          sent ? input.startedAt : null,
          sent ? preview : null,
          input.createdAt,
        ],
      );

      if (sent) {
        await client.query(
          `INSERT INTO messages
             (id, company_id, conversation_id, broadcast_id, direction, status,
              type, wamid, body, template_payload, error_source, error_code,
              error_title, occurred_at, delivered_at, read_at, failed_at,
              send_attempt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'OUTBOUND', $5::message_status, 'template',
                   $6, $7, $8::jsonb, $9::message_failure_source, $15, $10, $11,
                   $12, $13, $14, 0, $11, $11)`,
          [
            messageId,
            COMPANY.active,
            conversationId,
            input.id,
            recipient.status,
            `wamid.BROADCAST${messageId}`,
            preview,
            JSON.stringify({
              name: "order_shipped",
              language: "en_US",
              parameters: [`Customer ${index + 1}`, `NW-${2200 + index}`],
            }),
            recipient.error ? "META" : null,
            recipient.error ?? null,
            input.startedAt,
            recipient.status === "DELIVERED" || recipient.status === "READ"
              ? input.startedAt
              : null,
            recipient.status === "READ" ? input.startedAt : null,
            recipient.status === "FAILED" ? input.startedAt : null,
            /* $15. Meta's own code, so the dashboard can group failures by
               cause rather than reporting every one of them as "other". */
            recipient.code ?? null,
          ],
        );
      }

      await client.query(
        `INSERT INTO broadcast_recipients
           (id, company_id, broadcast_id, phone_e164, variables, state,
            message_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::broadcast_recipient_state, $7, $8)`,
        [
          recipientId,
          COMPANY.active,
          input.id,
          recipient.phone,
          JSON.stringify([`Customer ${index + 1}`, `NW-${2200 + index}`]),
          sent ? "SENT" : "PENDING",
          sent ? messageId : null,
          input.createdAt,
        ],
      );
    }
  }

  await seedBroadcastRun({
    id: BROADCAST.running,
    name: "Diwali reminder",
    status: "RUNNING",
    filename: "diwali-list.csv",
    recipients: RUNNING_RECIPIENTS,
    invalid: 0,
    createdAt: T_BROADCAST.runningCreated,
    startedAt: T_BROADCAST.runningStarted,
    finishedAt: null,
  });

  await seedBroadcastRun({
    id: BROADCAST.finished,
    name: "September restock",
    status: "COMPLETED",
    filename: "september-restock.csv",
    recipients: FINISHED_RECIPIENTS,
    invalid: 3,
    createdAt: T_BROADCAST.finishedCreated,
    startedAt: T_BROADCAST.finishedStarted,
    finishedAt: T_BROADCAST.finishedEnded,
  });

  /* ---------------------------------------------------------------- */
  /* Lead sources                                                       */
  /* ---------------------------------------------------------------- */

  /*
   * The healthy binding, and the one that has lost access to its sheet.
   *
   * cursor_count and cursor_anchor are literal because the page never renders
   * them - but they are written anyway, because a binding with a null anchor is
   * one that would rescan its whole sheet on the next poll, and a fixture that
   * quietly describes a state the product tries to avoid is a fixture that
   * teaches the wrong thing to whoever reads it next.
   *
   * webhook_key is literal for the reason the conventions record about this
   * exact column on integrations: it DEFAULTS to a database expression, so
   * leaving it out writes a fresh random value on every run. Nothing renders it
   * today - the Apps Script panel is collapsed, so the URL is not in the DOM -
   * and that is precisely the trap. The first change that opens that panel by
   * default would produce a baseline that never matched twice, and it would be
   * diagnosed as a flaky suite rather than as a fixture.
   */
  await client.query(
    `INSERT INTO lead_sources
       (id, company_id, name, spreadsheet_id, tab, sheet_gid, action,
        action_config, template_id, whatsapp_number_id, status,
        poll_interval_seconds, cursor_count, cursor_anchor, rows_seen,
        rows_sent, rows_skipped, rows_rejected, rows_duplicate, reject_reasons,
        last_polled_at, last_sent_at, webhook_key, created_by_user_id,
        created_at, updated_at)
     VALUES ($1, $2, 'Website enquiries', '1NorthwindLeadsSheetFixture0001',
             'Leads', 0, 'TEMPLATE', $3::jsonb, $4, $5, 'ACTIVE', 30,
             184, $6, 184, 171, 6, 7, 0, $7::jsonb, $8, $9,
             'fixtureleadhook00000000000000001',
             'c000visualfixtureuser001', $10, $10)`,
    [
      LEAD_SOURCE.healthy,
      COMPANY.active,
      JSON.stringify({
        kind: "TEMPLATE",
        templateId: FIXTURE.approvedTemplateId,
        mapping: LEAD_MAPPING,
      }),
      FIXTURE.approvedTemplateId,
      NUMBERS[0].id,
      "c000visualfixtureleadanchor00000000000000000000000000000000000001",
      JSON.stringify({ unparseable_phone: 5, missing_phone: 2 }),
      T_LEAD.healthyPolled,
      T_LEAD.healthySent,
      T_LEAD.healthyCreated,
    ],
  );

  /*
   * The lost-access binding.
   *
   * last_error is Google's own sentence, wrapped the way the action wraps it -
   * because "Requested entity was not found" alone is technically honest and
   * useless, and what the tenant reads has to say what to do about it. Nothing
   * has been sent, so last_sent_at is null and the page photographs the
   * "nothing sent yet" branch as well as the error.
   */
  await client.query(
    `INSERT INTO lead_sources
       (id, company_id, name, spreadsheet_id, tab, sheet_gid, action,
        action_config, template_id, whatsapp_number_id, status,
        poll_interval_seconds, cursor_count, cursor_anchor, rows_seen,
        rows_sent, rows_skipped, rows_rejected, rows_duplicate, reject_reasons,
        last_polled_at, last_error, last_error_at, webhook_key,
        created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, 'Trade show sign-ups', '1NorthwindTradeShowFixture0002',
             'Sheet1', 0, 'TEMPLATE', $3::jsonb, $4, $5, 'ERROR', 30,
             0, NULL, 0, 0, 0, 0, 0, '{}'::jsonb, $6, $7, $8,
             'fixtureleadhook00000000000000002',
             'c000visualfixtureuser001', $9, $9)`,
    [
      LEAD_SOURCE.lost,
      COMPANY.active,
      JSON.stringify({
        kind: "TEMPLATE",
        templateId: FIXTURE.approvedTemplateId,
        mapping: LEAD_MAPPING,
      }),
      FIXTURE.approvedTemplateId,
      NUMBERS[0].id,
      T_LEAD.lostPolled,
      "We cannot see that spreadsheet. Share it with the service account, " +
        "as Editor, then try again. (Google said: Requested entity was not " +
        "found.)",
      T_LEAD.lostFailed,
      T_LEAD.lostCreated,
    ],
  );

  /*
   * The healthy binding's leads, each one a real contact, conversation and
   * message - because that is exactly what a lead IS after materialisation.
   * Nothing here is a lead-shaped parallel row; the feed reads the same tables
   * the inbox does.
   */
  let leadRowIndex = 0;

  for (const lead of LEAD_ROWS) {
    const n = String(leadRowIndex).padStart(6, "0");
    const contactId = `c000visualfixturelc${n}`;
    const conversationId = `c000visualfixturelv${n}`;
    const messageId = `c000visualfixturelm${n}`;
    const rowId = `c000visualfixturelr${n}`;
    /* Literal and descending, so the feed's order is fixed rather than
       whatever one transaction's clock produced. */
    const at = `2026-08-15T0${5 - Math.min(leadRowIndex, 4)}:00:00Z`;
    leadRowIndex += 1;

    await client.query(
      `INSERT INTO contacts (id, company_id, wa_id, phone_e164, display_name,
                             created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        contactId,
        COMPANY.active,
        lead.phone.slice(1),
        lead.phone,
        null,
        at,
      ],
    );

    if (lead.state === "SENT") {
      await client.query(
        `INSERT INTO conversations
           (id, company_id, contact_id, whatsapp_number_id, source,
            last_message_at, last_message_preview, unread_count,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'CAMPAIGN', $5, $6, 0, $5, $5)`,
        [
          conversationId,
          COMPANY.active,
          contactId,
          NUMBERS[0].id,
          at,
          "Hi there, thanks for getting in touch about NW-2291.",
        ],
      );

      await client.query(
        `INSERT INTO messages
           (id, company_id, conversation_id, direction, status, type, body,
            template_payload, occurred_at, send_attempt, error_source,
            error_title, failed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'OUTBOUND', $4::message_status, 'template', $5,
                 $6::jsonb, $7, 0, $8, $9, $10, $7, $7)`,
        [
          messageId,
          COMPANY.active,
          conversationId,
          lead.status,
          "Hi there, thanks for getting in touch about NW-2291.",
          JSON.stringify({
            name: "order_ready",
            language: "en_US",
            parameters: ["there", "NW-2291"],
          }),
          at,
          lead.error ? "META" : null,
          lead.error ?? null,
          lead.error ? at : null,
        ],
      );
    }

    await client.query(
      `INSERT INTO lead_source_rows
         (id, company_id, lead_source_id, spreadsheet_id, tab, row_hash,
          phone_e164, state, skip_reason, message_id, created_at)
       VALUES ($1, $2, $3, '1NorthwindLeadsSheetFixture0001', 'Leads', $4, $5,
               $6::lead_source_row_state, $7, $8, $9)`,
      [
        rowId,
        COMPANY.active,
        LEAD_SOURCE.healthy,
        `fixture-row-hash-${n}`,
        lead.phone,
        lead.state,
        lead.skip,
        lead.state === "SENT" ? messageId : null,
        at,
      ],
    );
  }

  /*
   * Unroutable deliveries, so the operator card photographs a real reading
   * rather than three zeroes. One of each reason, because they are different
   * problems and the card splits them - and the counts are deliberately small
   * and different from each other, so a card that rendered the same number
   * twice would be visibly wrong rather than plausibly right.
   *
   * lastSeenAt is stamped relative to now, and the rule at the top of this file
   * holds: the card windows on the last 7 days and renders a COUNT, never the
   * instant. A literal would age out of that window and the card would fall to
   * zero on a date nobody wrote down.
   */
  const unroutable = [
    ["c000visualfixtureunroute1", "UNKNOWN_KEY", 4, 2],
    ["c000visualfixtureunroute2", "BAD_SIGNATURE", 11, 1],
  ];

  for (const [id, reason, attempts, daysAgo] of unroutable) {
    await client.query(
      `INSERT INTO unroutable_webhooks
         (id, webhook_key_hash, reason, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3::unroutable_reason, $4,
               now() - ($5 || ' days')::interval,
               now() - ($5 || ' days')::interval)`,
      [id, `${id}-hash`, reason, attempts, String(daysAgo)],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Phase 9: what the dashboard reads                                  */
  /* ---------------------------------------------------------------- */

  /*
   * Three threads whose window shuts inside the dashboard's horizon.
   *
   * These are the card that turns the page into a tool, and without them it
   * photographs its own empty state - which is the one card of the six most
   * worth looking at. They also appear in the inbox, deliberately: a thread
   * that exists for one page and not another would be a fixture describing a
   * database that cannot happen.
   *
   * No messages on them beyond the preview, which is denormalised onto the
   * conversation anyway. The dashboard reads the preview and the expiry; adding
   * message rows would change every count on the page for no picture.
   */
  for (const thread of CLOSING_THREADS) {
    await client.query(
      `INSERT INTO contacts (id, company_id, wa_id, phone_e164, profile_name,
                             created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        thread.contactId,
        COMPANY.active,
        thread.waId,
        thread.phone,
        thread.name,
        T.companyCreated,
      ],
    );

    /*
     * The window is relative to now(); the two timestamps beside it are
     * literals. That split is not sloppiness, it is the rule at the top of this
     * file applied to each column by what RENDERS it.
     *
     * `window_expires_at` has to move, or the thread stops being near its
     * deadline the day after the baseline is recorded. Nothing prints it as an
     * instant - the inbox badge and the dashboard card both render a bucket
     * through windowBucket - so a moving value costs nothing.
     *
     * `last_message_at` IS printed, by the inbox, as an absolute time. Deriving
     * it from the window made it move too, and both inbox baselines shifted by
     * ~160 pixels a run - which is not rasteriser noise, and which is how this
     * was found rather than reasoned about.
     *
     * The two are then mutually inconsistent, in that a window closing in eight
     * minutes implies an inbound 23h52m ago rather than in August. The open
     * thread above has carried exactly that inconsistency since Phase 4 for the
     * same reason and says so. Nothing reads both, and the alternative is a
     * fixture that cannot be photographed.
     *
     * The literals are older than the two hand-written threads, so these sort
     * below them and the existing inbox baselines keep their order.
     */
    await client.query(
      `INSERT INTO conversations (id, company_id, contact_id, whatsapp_number_id,
                                  source, last_inbound_at, last_message_at,
                                  last_message_preview, window_expires_at,
                                  unread_count, assigned_user_id, assigned_at,
                                  created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'INBOUND'::conversation_source, $8, $8, $6,
               now() + ($5 || ' minutes')::interval,
               0, NULL, NULL, $7, $7)`,
      [
        thread.id,
        COMPANY.active,
        thread.contactId,
        NUMBERS[0].id,
        String(thread.minutes),
        thread.preview,
        T.companyCreated,
        thread.lastMessageAt,
      ],
    );
  }

  /* A template still waiting on Meta, so the queue card has a row in it. */
  await client.query(
    `INSERT INTO whatsapp_templates
       (id, company_id, integration_id, name, language, category, components,
        status, meta_template_id, rejected_reason, status_updated_at,
        created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', NULL, NULL, NULL,
             'c000visualfixtureuser001',
             now() - ($8 || ' days')::interval,
             now() - ($8 || ' days')::interval)`,
    [
      PENDING_TEMPLATE.id,
      COMPANY.active,
      INTEGRATION.whatsapp,
      PENDING_TEMPLATE.name,
      PENDING_TEMPLATE.language,
      PENDING_TEMPLATE.category,
      JSON.stringify(PENDING_TEMPLATE.components),
      String(PENDING_TEMPLATE.daysWaiting),
    ],
  );

  console.log(
    `Seeded ${TEST_DATABASE_NAME}: 4 companies, ${users.length} users, ` +
      `4 integrations, ${secretId} secrets, ${verifications.length} verifications, ` +
      `${USAGE.length} usage events, ${NUMBERS.length} WhatsApp numbers, ` +
      `${CONTACTS.length} contacts, 2 conversations, ${MESSAGES.length} messages, ` +
      `1 media row, ${TEMPLATES.length} templates, ${templateEditId} template edits, ` +
      `${KYC_DOCUMENTS.length} approved KYC documents, ` +
      `3 broadcasts, 2 lead sources, ${LEAD_ROWS.length} leads, ` +
      `${BLOCKED_KYC_DOCUMENTS.length} for the unverified workspace, ` +
      `${CLOSING_THREADS.length} threads closing within the hour, ` +
      `1 pending template, and an empty verified workspace.`,
  );
/* ==========================================================================
   The flow builder
   ========================================================================== */

const FLOW = {
  id: "c000visualfixtureflow00001",
  versionId: "c000visualfixtureflowver01",
  /** Two contacts of their own, so the flow's threads are not the inbox's. */
  activeContactId: "c000visualfixtureflowcont1",
  pausedContactId: "c000visualfixtureflowcont2",
  activeConversationId: "c000visualfixtureflowconv1",
  pausedConversationId: "c000visualfixtureflowconv2",
  activeRunId: "c000visualfixtureflowrun01",
  pausedRunId: "c000visualfixtureflowrun02",
  doneRunId: "c000visualfixtureflowrun03",
  handedRunId: "c000visualfixtureflowrun04",
};

/**
 * A real multi-node tree, not a two-node stub.
 *
 * The builder's whole claim is that a structured list expresses a tree, and a
 * picture of two nodes proves nothing about that. This one has the entry, a
 * three-button question, a branch on what was answered, an action that scores
 * the lead, a handoff and an end - which is every node kind the phase ships
 * except collect, and it is the shape a real enquiry flow actually takes.
 */
const FLOW_GRAPH = {
  entryNodeId: "start",
  nodes: [
    {
      id: "start",
      kind: "entry",
      templateId: FIXTURE.approvedTemplateId,
      variables: [],
      choices: [{ key: "yes", label: "Yes, tell me more", next: "n2" }],
    },
    {
      id: "n2",
      kind: "question",
      body: "Lovely. What are you looking for today?",
      variable: "want",
      presentation: {
        as: "buttons",
        choices: [
          { key: "spices", label: "Spices", next: "n3" },
          { key: "jaggery", label: "Jaggery", next: "n3" },
          { key: "someone", label: "Talk to someone", next: "n6" },
        ],
      },
    },
    {
      id: "n3",
      kind: "action",
      actions: [{ kind: "set_score", score: "HOT" }],
      next: "n4",
    },
    {
      id: "n4",
      kind: "question",
      body: "How soon do you need it?",
      variable: "when",
      presentation: {
        as: "buttons",
        choices: [
          { key: "week", label: "This week", next: "n6" },
          { key: "month", label: "This month", next: "n5" },
        ],
      },
    },
    {
      id: "n5",
      kind: "end",
      body: "Thanks. We will send the current price list closer to the time.",
    },
    {
      id: "n6",
      kind: "handoff",
      body: "One of our team will pick this up shortly.",
      note: "Ready to buy",
    },
  ],
};

/**
 * The three pictures the phase is about, and one of them is the reason this
 * fixture exists at all.
 *
 * A run mid-conversation and a completed one are the states anybody building
 * the feature already has on their machine. A PAUSED run - the window shut
 * while somebody was halfway down the tree - is the one a tenant asks about
 * and the one least likely to be looked at, because it takes a day of silence
 * to produce and nobody waits a day while building a page.
 *
 * -------------------------------------------------------------------------
 * Which timestamps move and which are literal
 * -------------------------------------------------------------------------
 *
 * The rule is decided by what RENDERS a column, not by the table it is in.
 *
 * started_at is printed absolutely on the flow page, so every one is a fixed
 * instant. The ACTIVE run's conversation carries a window relative to now(),
 * because the inbox renders it as an open/closed state and a run that is
 * permanently mid-conversation has to still be inside its window tomorrow. The
 * PAUSED run's window is a literal in the past, and that is safe for the
 * opposite reason: closed stays closed however long the baseline sits there.
 */
const FLOW_RUNS = [
  {
    id: FLOW.activeRunId,
    contactId: FLOW.activeContactId,
    conversationId: FLOW.activeConversationId,
    status: "ACTIVE",
    currentNodeId: "n4",
    variables: { want: "spices" },
    stepCount: 6,
    startedAt: "2026-08-14T08:40:00Z",
    pausedAt: null,
    endedAt: null,
  },
  {
    id: FLOW.pausedRunId,
    contactId: FLOW.pausedContactId,
    conversationId: FLOW.pausedConversationId,
    status: "PAUSED",
    /* The position is kept. That is the entire difference from failing, and
       the CHECK in 20260906090000 refuses a PAUSED row without one. */
    currentNodeId: "n2",
    variables: {},
    stepCount: 3,
    startedAt: "2026-08-11T11:05:00Z",
    pausedAt: "2026-08-12T11:20:00Z",
    endedAt: null,
  },
  {
    id: FLOW.doneRunId,
    contactId: CONTACTS[0].id,
    conversationId: CONVERSATION.open,
    status: "COMPLETED",
    currentNodeId: null,
    variables: { want: "jaggery", when: "month" },
    stepCount: 9,
    startedAt: "2026-08-10T06:15:00Z",
    pausedAt: null,
    endedAt: "2026-08-10T06:19:00Z",
  },
  {
    id: FLOW.handedRunId,
    contactId: CONTACTS[1].id,
    conversationId: CONVERSATION.closed,
    status: "HANDED_OFF",
    currentNodeId: null,
    variables: { want: "someone" },
    stepCount: 4,
    startedAt: "2026-08-09T09:02:00Z",
    pausedAt: null,
    endedAt: "2026-08-09T09:03:00Z",
  },
];


await client.query(
  `INSERT INTO contacts (id, company_id, wa_id, phone_e164, profile_name,
                         display_name, lead_score, lead_score_at,
                         lead_score_run_id, tags, created_at, updated_at)
   VALUES ($1, $3, '919845012501', '+919845012501', 'Devika Rao', NULL,
           'HOT'::lead_score, $4, $5, ARRAY['spices'], $6, $6),
          ($2, $3, '919845012502', '+919845012502', 'Farhan Qureshi', NULL,
           NULL, NULL, NULL, ARRAY[]::text[], $6, $6)`,
  [
    FLOW.activeContactId,
    FLOW.pausedContactId,
    COMPANY.active,
    "2026-08-14T08:41:00Z",
    FLOW.activeRunId,
    "2026-08-09T05:30:00Z",
  ],
);

/*
 * The active thread's window moves with the clock; the paused one's does not.
 * See the note above FLOW_RUNS - the two are opposite cases of the same rule.
 */
await client.query(
  `INSERT INTO conversations (id, company_id, contact_id, whatsapp_number_id,
                              source, last_inbound_at, last_message_at,
                              last_message_preview, window_expires_at,
                              unread_count, created_at, updated_at)
   VALUES ($1, $3, $4, $6, 'INBOUND'::conversation_source, $7, $8, $9,
           now() + interval '11 hours', 0, $7, $8),
          ($2, $3, $5, $6, 'INBOUND'::conversation_source, $10, $11, $12,
           $13, 0, $10, $11)`,
  [
    FLOW.activeConversationId,
    FLOW.pausedConversationId,
    COMPANY.active,
    FLOW.activeContactId,
    FLOW.pausedContactId,
    NUMBERS[0].id,
    "2026-08-14T08:40:00Z",
    "2026-08-14T08:41:00Z",
    "How soon do you need it?",
    "2026-08-11T11:05:00Z",
    "2026-08-11T11:06:00Z",
    "Lovely. What are you looking for today?",
    /* 24 hours after the last inbound, and comfortably past. The window shut
       with the customer standing on n2, which is why the run is paused. */
    "2026-08-12T11:05:00Z",
  ],
);

await client.query(
  `INSERT INTO flows (id, company_id, name, published_version_id, archived_at,
                      created_by_user_id, created_at, updated_at)
   VALUES ($1, $2, 'New enquiry', NULL, NULL, 'c000visualfixtureuser001',
           $3, $3)`,
  [FLOW.id, COMPANY.active, "2026-08-08T07:00:00Z"],
);

await client.query(
  `INSERT INTO flow_versions (id, company_id, flow_id, version, graph,
                              entry_template_id, published_at,
                              published_by_user_id, created_by_user_id,
                              created_at, updated_at)
   VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, 'c000visualfixtureuser001',
           'c000visualfixtureuser001', $6, $6)`,
  [
    FLOW.versionId,
    COMPANY.active,
    FLOW.id,
    JSON.stringify(FLOW_GRAPH),
    FIXTURE.approvedTemplateId,
    "2026-08-08T07:20:00Z",
  ],
);

/* The pointer, set after the version exists: flows.published_version_id has
   a foreign key at it, and the two tables reference each other. */
await client.query(`UPDATE flows SET published_version_id = $1 WHERE id = $2`, [
  FLOW.versionId,
  FLOW.id,
]);

for (const run of FLOW_RUNS) {
  await client.query(
    `INSERT INTO flow_runs (id, company_id, flow_id, flow_version_id,
                            conversation_id, contact_id,
                            active_conversation_id, status, current_node_id,
                            variables, step_count, started_at, paused_at,
                            ended_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::flow_run_status, $9, $10::jsonb,
             $11, $12, $13, $14, $12, $12)`,
    [
      run.id,
      COMPANY.active,
      FLOW.id,
      FLOW.versionId,
      run.conversationId,
      run.contactId,
      /* Non-null exactly while the run is live - the CHECK that makes the
         unique index mean "one live run per conversation". */
      run.status === "ACTIVE" || run.status === "PAUSED" ? run.conversationId : null,
      run.status,
      run.currentNodeId,
      JSON.stringify(run.variables),
      run.stepCount,
      run.startedAt,
      run.pausedAt,
      run.endedAt,
    ],
  );
}

/*
 * The active run's thread, as real messages.
 *
 * A flow's messages are ordinary message rows - that is the phase's whole
 * claim about not being a second send path - so the thread page renders them
 * with no knowledge of flows at all. Seeding them any other way would
 * photograph a fiction.
 *
 * The interactive payload carries ids naming this run and node, exactly as
 * buildInteractivePayload writes them. A tap on the older question would
 * resolve to n2, which the run has left, and be declined.
 */
const FLOW_MESSAGES = [
  {
    id: "c000visualfixtureflowmsg1",
    direction: "INBOUND",
    status: "DELIVERED",
    type: "button",
    wamid: "wamid.FIXTUREFLOWIN1",
    body: "Yes, tell me more",
    interactive: null,
    occurredAt: "2026-08-14T08:40:00Z",
  },
  {
    id: "c000visualfixtureflowmsg2",
    direction: "OUTBOUND",
    status: "READ",
    type: "interactive",
    wamid: "wamid.FIXTUREFLOWOUT1",
    body: "Lovely. What are you looking for today?\n\n- Spices\n- Jaggery\n- Talk to someone",
    interactive: {
      type: "button",
      body: { text: "Lovely. What are you looking for today?" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.activeRunId}.n2.spices`, title: "Spices" },
          },
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.activeRunId}.n2.jaggery`, title: "Jaggery" },
          },
          {
            type: "reply",
            reply: {
              id: `f1.r.${FLOW.activeRunId}.n2.someone`,
              title: "Talk to someone",
            },
          },
        ],
      },
    },
    occurredAt: "2026-08-14T08:40:20Z",
  },
  {
    id: "c000visualfixtureflowmsg3",
    direction: "INBOUND",
    status: "DELIVERED",
    type: "interactive",
    wamid: "wamid.FIXTUREFLOWIN2",
    body: "Spices",
    interactive: null,
    occurredAt: "2026-08-14T08:40:50Z",
  },
  {
    id: "c000visualfixtureflowmsg4",
    direction: "OUTBOUND",
    status: "DELIVERED",
    type: "interactive",
    wamid: "wamid.FIXTUREFLOWOUT2",
    body: "How soon do you need it?\n\n- This week\n- This month",
    interactive: {
      type: "button",
      body: { text: "How soon do you need it?" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.activeRunId}.n4.week`, title: "This week" },
          },
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.activeRunId}.n4.month`, title: "This month" },
          },
        ],
      },
    },
    occurredAt: "2026-08-14T08:41:00Z",
  },
];

for (const message of FLOW_MESSAGES) {
  await client.query(
    `INSERT INTO messages (id, company_id, conversation_id, direction, status,
                           type, wamid, body, interactive_payload,
                           send_attempt, occurred_at, delivered_at, read_at,
                           created_at, updated_at)
     VALUES ($1, $2, $3, $4::message_direction, $5::message_status, $6, $7,
             $8, $9::jsonb, 0, $10, $10, $11, $10, $10)`,
    [
      message.id,
      COMPANY.active,
      FLOW.activeConversationId,
      message.direction,
      message.status,
      message.type,
      message.wamid,
      message.body,
      message.interactive ? JSON.stringify(message.interactive) : null,
      message.occurredAt,
      message.status === "READ" ? message.occurredAt : null,
    ],
  );
}

/*
 * The paused thread's one exchange, so the picture shows a conversation that
 * stopped rather than one that never started.
 */
await client.query(
  `INSERT INTO messages (id, company_id, conversation_id, direction, status,
                         type, wamid, body, interactive_payload, send_attempt,
                         occurred_at, delivered_at, created_at, updated_at)
   VALUES ($1, $2, $3, 'INBOUND'::message_direction,
           'DELIVERED'::message_status, 'button', 'wamid.FIXTUREFLOWIN3',
           'Yes, tell me more', NULL, 0, $4, $4, $4, $4),
          ($5, $2, $3, 'OUTBOUND'::message_direction,
           'DELIVERED'::message_status, 'interactive', 'wamid.FIXTUREFLOWOUT3',
           $6, $7::jsonb, 0, $8, $8, $8, $8)`,
  [
    "c000visualfixtureflowmsg5",
    COMPANY.active,
    FLOW.pausedConversationId,
    "2026-08-11T11:05:00Z",
    "c000visualfixtureflowmsg6",
    "Lovely. What are you looking for today?\n\n- Spices\n- Jaggery\n- Talk to someone",
    JSON.stringify({
      type: "button",
      body: { text: "Lovely. What are you looking for today?" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.pausedRunId}.n2.spices`, title: "Spices" },
          },
          {
            type: "reply",
            reply: { id: `f1.r.${FLOW.pausedRunId}.n2.jaggery`, title: "Jaggery" },
          },
          {
            type: "reply",
            reply: {
              id: `f1.r.${FLOW.pausedRunId}.n2.someone`,
              title: "Talk to someone",
            },
          },
        ],
      },
    }),
    "2026-08-11T11:06:00Z",
  ],
);

/*
 * Steps for the two live runs. Append-only, and seeded through the same
 * columns the executor writes - a fixture that invented a shape would be a
 * picture of a table the product does not produce.
 */
const STEPS = [
  [FLOW.activeRunId, 1, "STARTED", "start", "yes", null],
  [FLOW.activeRunId, 2, "SENT", "n2", null, "c000visualfixtureflowmsg2"],
  [FLOW.activeRunId, 3, "ADVANCED", "n2", "spices", "c000visualfixtureflowmsg3"],
  [FLOW.activeRunId, 4, "ACTION", "n3", null, null],
  [FLOW.activeRunId, 5, "SENT", "n4", null, "c000visualfixtureflowmsg4"],
  [FLOW.pausedRunId, 1, "STARTED", "start", "yes", null],
  [FLOW.pausedRunId, 2, "SENT", "n2", null, "c000visualfixtureflowmsg6"],
  [FLOW.pausedRunId, 3, "PAUSED", null, null, null],
];

for (const [runId, seq, kind, nodeId, choice, messageId] of STEPS) {
  await client.query(
    `INSERT INTO flow_run_steps (id, company_id, flow_run_id, seq, kind,
                                 node_id, choice, message_id, detail,
                                 occurred_at)
     VALUES ($1, $2, $3, $4, $5::flow_step_kind, $6, $7, $8, '{}'::jsonb, $9)`,
    [
      `c000visualfixturestep${runId.slice(-2)}${String(seq).padStart(2, "0")}`,
      COMPANY.active,
      runId,
      seq,
      kind,
      nodeId,
      choice,
      messageId,
      "2026-08-14T08:41:00Z",
    ],
  );
}

  /*
   * The rollups, computed by the real refresh rather than written as literals.
   *
   * ---------------------------------------------------------------------------
   * Why this one fixture is derived and not stated
   * ---------------------------------------------------------------------------
   *
   * Every other value in this file is a literal, because a screenshot suite is
   * only worth having if a diff means something changed. A rollup is the
   * exception, and the reason is that its correctness is defined by agreement
   * with the rows above it: a literal `messages_total` here would be a second
   * copy of a number this file already determines, and the two would drift the
   * first time anybody adds a message to MESSAGES.
   *
   * Deriving it keeps the fixture deterministic anyway - the same seeded rows
   * produce the same counts every run - while making it impossible for the
   * picture to show a total the data does not support. It also means the
   * screenshot exercises the real statement, which is the one thing a hand
   * written row could never do.
   *
   * `computed_at` is now(), and that is safe because the page renders freshness
   * as a bucket with no digits in it while the refresh is running - see
   * freshnessLabel. If that ever becomes a ticking age, this becomes a fixture
   * that never matches twice.
   */
  process.env["DATABASE_URL_APP"] = testAppDatabaseUrl();

  const { refreshDashboardRollup, withCompany } = await import("@whatsapp-os/db");
  const { dashboardWindows } = await import("@whatsapp-os/core/dashboard");

  const windows = dashboardWindows();

  for (const companyId of [COMPANY.active, COMPANY.fresh]) {
    await withCompany(companyId, (db) =>
      refreshDashboardRollup(db, {
        computedAt: windows.now,
        dayStart: windows.dayStart,
        monthStart: windows.monthStart,
      }),
    );
  }

} finally {
  await client.end();
}

process.exit(0);
