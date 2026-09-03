import "./_load-env.mjs";

import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * A tenant you can actually sign in as, in the development database.
 *
 *     npm run seed:dev
 *
 * ===========================================================================
 * WHY THIS IS DATA AND NOT A FLAG
 * ===========================================================================
 *
 * A4 blocks every feature section until all three KYC documents are approved.
 * That is the correct behaviour and it makes a freshly signed-up developer
 * account useless: every page is the gate, so nothing can be looked at, and the
 * obvious fix is a bypass - an env var, a `NODE_ENV !== "production"` arm in
 * canUseFeatures, a "skip KYC" flag.
 *
 * This repository has found that shape twice and written it down both times.
 * LEAD_SHEET_FIXTURE nearly became it, and the conventions record the general
 * rule: a guard that refuses its own only legitimate use gets DELETED rather
 * than fixed, and the deletion happens six months later in a hurry, by
 * somebody who does not know what it was for.
 *
 * So the gate is untouched. This writes the rows a verified company actually
 * has: three real documents in APPROVED status with a reviewing admin
 * recorded, produced by the same functions the upload form and the admin
 * panel call. A company seeded here and a company an operator approved by hand
 * are the same company - there is no state one has that the other does not,
 * and `canUseFeatures` cannot tell them apart because there is nothing to tell.
 *
 * ===========================================================================
 * THE NORMAL PATHS, NAMED
 * ===========================================================================
 *
 *   signUp()                   company, owner, password hash, audit, token
 *   consumeVerificationToken() spends that token, stamping email_verified_at
 *   putKycDocument()           three PENDING uploads with real PDF bytes
 *   decideKycDocument()        the admin panel's own approval, per document
 *
 * Nothing here writes a status column directly. The one thing it does that a
 * person would not is consume the verification token itself instead of
 * clicking the link in an email nobody is going to send.
 */

/* ------------------------------------------------------------------------- *
 * The guard, before anything is imported that might connect
 * ------------------------------------------------------------------------- */

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "..", "..", "..", ".env");

/**
 * Read from the FILE, never from process.env.
 *
 * db-nuke.mjs learned this and the reasoning transfers exactly: comparing the
 * target against `process.env.DATABASE_URL` is circular - the target IS that
 * value - so the check passes by construction while an exported override
 * points the script somewhere else entirely. That version printed
 * "Rebuilding production_db" and meant it.
 */
let declaredUrl;
try {
  declaredUrl = dotenv.parse(readFileSync(envPath))["DATABASE_URL"];
} catch {
  console.error(`Could not read ${envPath}. Copy .env.example to .env.`);
  process.exit(1);
}

if (!declaredUrl) {
  console.error(`DATABASE_URL is not set in ${envPath}.`);
  process.exit(1);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const parsed = new URL(declaredUrl);
const databaseName = parsed.pathname.replace(/^\//, "");

/**
 * Both conditions, never either - the same pair db-nuke.mjs requires.
 *
 * Loopback alone is not enough: `kubectl port-forward` and SSH tunnels put
 * production databases on localhost every day, and that is the ordinary way an
 * engineer reaches one. The name alone is not enough either: nothing stops a
 * remote database from being called whatsapp_os.
 *
 * And the name here is `whatsapp_os` ONLY - not the test database. This script
 * creates a signed-in-able account with a printed password; the test database
 * is truncated by every suite and seeded by the screenshot fixture, and a
 * second writer putting accounts into it would be a fixture nobody declared.
 */
if (!LOOPBACK.has(parsed.hostname)) {
  console.error(
    `Refusing to seed a database on "${parsed.hostname}".\n\n` +
      "This creates an account with a known password. It runs against a local\n" +
      "development database and nothing else.",
  );
  process.exit(1);
}

if (databaseName !== "whatsapp_os") {
  console.error(
    `Refusing to seed "${databaseName}".\n\n` +
      "Only the development database whatsapp_os may be seeded this way.\n" +
      "The test database is owned by the suites and the screenshot fixture.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * What gets created
 * ------------------------------------------------------------------------- */

/**
 * A password that will pass the real checks rather than dodge them.
 *
 * signUp runs the common-password denylist and a HaveIBeenPwned lookup, and
 * this has to satisfy both honestly - the point of the script is a company
 * created the way a company is created. Random base64 clears the denylist by
 * construction and cannot be in a breach corpus.
 *
 * Printed once at the end and stored nowhere: this is a development account on
 * a loopback database, and writing the password to a file would put it
 * somewhere a later commit could pick it up.
 */
const password = `Dev-${randomBytes(12).toString("base64url")}-9x`;

const stamp = Date.now().toString(36).slice(-6);
const username = `dev_${stamp}`;
const email = `dev_${stamp}@example.test`;

/**
 * A real, minimal PDF.
 *
 * kyc_documents carries a CHECK that the first five bytes are `%PDF-`, and
 * another tying byte_size to octet_length(bytes) - so a placeholder blob is
 * refused by the database rather than accepted and discovered later. The
 * trailing EOF marker makes it a file a browser will actually render, which
 * matters because the admin tab serves it inline.
 */
const PDF_BYTES = Buffer.from(
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

const KYC_KINDS = [
  { kind: "GST", filename: "gst-certificate.pdf" },
  { kind: "PAN", filename: "pan-card.pdf" },
  { kind: "AADHAAR", filename: "aadhaar-card.pdf" },
];

/*
 * Imported after the guard, and dynamically.
 *
 * These modules connect on import, so a static import would open a connection
 * before the refusals above had a chance to run - which is the whole point of
 * putting them first. `_load-env.mjs` is imported at the very top for the
 * reason apps/web/scripts all do: ESM hoists imports, so a dotenv call in the
 * body runs after every imported module has already parsed an empty
 * environment and exited.
 */
const { signUp } = await import("../lib/auth/signup.ts");
const { consumeVerificationToken } = await import("../lib/auth/verify-email.ts");
const { upsertAdminUser, decideKycDocument } = await import("../lib/admin-db.ts");
const { putKycDocument, currentKycStatuses, withCompany } = await import(
  "@whatsapp-os/db"
);
const { hashPassword } = await import("@whatsapp-os/core");
const { canUseFeatures } = await import("@whatsapp-os/core/kyc");

/* ------------------------------------------------------------------------- *
 * 1. The company and its owner, through signUp
 * ------------------------------------------------------------------------- */

const result = await signUp({
  fullName: "Dev Owner",
  companyName: `Dev Workspace ${stamp}`,
  email,
  phone: "+919876543210",
  username,
  password,
  confirmPassword: password,
});

if (!result.ok) {
  console.error(`\nsignUp refused: ${result.error.reason}\n`);
  process.exit(1);
}

const { companyId, verificationToken } = result.value;

/* ------------------------------------------------------------------------- *
 * 2. The verified email, by issuing and spending a real token
 * ------------------------------------------------------------------------- */

/*
 * The token signUp ALREADY issued, spent - not a fresh one, and not a direct
 * write to email_verified_at.
 *
 * signUp returns `verificationToken` because that is what the sign-up flow
 * puts in the email. Consuming it is exactly what clicking the link does, and
 * it is the only step here a person would do differently: they would open
 * their inbox.
 *
 * Stamping the column instead would leave the issued token unspent, so the
 * account would carry a live link to verify an address already verified - a
 * state the real flow cannot produce.
 */
const verified = await consumeVerificationToken(verificationToken);

if (!verified.ok) {
  console.error(`\nCould not verify the email: ${verified.reason}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * 3. Three documents, uploaded then approved
 * ------------------------------------------------------------------------- */

/**
 * A reviewing admin, because an approval has one.
 *
 * kyc_documents.reviewed_by_admin_id is how the panel records who decided, and
 * a company approved by nobody is a row the real path cannot produce. The
 * password hash is random and never printed: this account exists to be a
 * foreign key, and `npm run admin:seed` is how somebody gets an admin they can
 * actually sign in as.
 */
const admin = await upsertAdminUser(
  "dev-seed-reviewer",
  await hashPassword(randomBytes(24).toString("base64url")),
);

const documentIds = await withCompany(companyId, async (db, scoped) => {
  const ids = [];

  for (const document of KYC_KINDS) {
    ids.push(
      await putKycDocument(db, scoped, {
        kind: document.kind,
        bytes: PDF_BYTES,
        sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
        mimeType: "application/pdf",
        originalFilename: document.filename,
      }),
    );
  }

  return ids;
});

for (const documentId of documentIds) {
  /*
   * The panel's own function, including its optimistic guard: it only lands if
   * the row is still in the status the caller expected. Passing PENDING here
   * is not ceremony - it is what makes this the same write the admin makes,
   * and a future change to that guard breaks this script rather than silently
   * diverging from it.
   */
  const landed = await decideKycDocument({
    documentId,
    status: "APPROVED",
    reviewNote: null,
    adminUserId: admin.id,
    expectedStatus: "PENDING",
  });

  if (!landed) {
    console.error(`\nCould not approve ${documentId}.\n`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------------- *
 * 4. Ask the gate itself, rather than assuming the rows were enough
 * ------------------------------------------------------------------------- */

/*
 * The real `canUseFeatures`, over the real `currentKycStatuses` - the same two
 * calls getFeatureAccess makes, minus the requireSession a script has no
 * request for.
 *
 * Everything above is an argument that these rows are what an approved company
 * has. This is the only line that CHECKS it, and it is here because the failure
 * this script is most likely to have is silent: three documents written, all
 * APPROVED, and a gate that wants a fourth kind or a column nobody set. Without
 * this the script prints a password for an account that cannot open a single
 * page, and the person who runs it finds out one navigation later - by which
 * point the obvious suspect is the gate rather than the seed.
 *
 * It also fails the day A4 gains a requirement. That is the point: this script
 * is a claim about what the gate wants, and a claim nothing evaluates goes
 * stale without anybody noticing.
 */
const access = await withCompany(companyId, async (db, scoped) =>
  canUseFeatures({
    companyDeactivated: false,
    documents: await currentKycStatuses(db, scoped),
  }),
);

if (!access.allowed) {
  console.error(
    `\nSeeded, but the gate still refuses this company: ${access.reason}\n\n` +
      "The documents were written and approved through the ordinary paths, so\n" +
      "A4 now wants something this script does not produce. Fix the script to\n" +
      "produce it. Do not add an exemption to canUseFeatures.\n",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------- *
 * 5. Say what was made
 * ------------------------------------------------------------------------- */

console.log(
  [
    "",
    "  A verified development tenant is ready.",
    "",
    `    username   ${username}`,
    `    password   ${password}`,
    "",
    `    company    Dev Workspace ${stamp}`,
    `    email      ${email} (verified)`,
    "    documents  GST, PAN and AADHAAR, all APPROVED",
    "",
    "  Sign in at http://localhost:3000/sign-in",
    "",
    "  The password is printed once and stored nowhere. Run this again for a",
    "  fresh tenant - it never edits an existing one.",
    "",
  ].join("\n"),
);

process.exit(0);
