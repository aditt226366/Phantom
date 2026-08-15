import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { TEST_DATABASE_NAME } from "./db-urls.mjs";

/**
 * Rebuild a development database from nothing.
 *
 *     npm run db:nuke -- dev
 *     npm run db:nuke -- test
 *
 * ---------------------------------------------------------------------------
 * Why this is a script and not four commands in a README
 * ---------------------------------------------------------------------------
 *
 * `prisma migrate reset` leaves the database wedged. It drops and recreates
 * schema public, which lands owned by the bootstrap superuser, so
 * whatsapp_owner loses CREATE and the next `migrate deploy` fails with
 * "permission denied for schema public". That failure is then *recorded* as a
 * failed migration, and every subsequent run refuses with P3009 — so the
 * obvious next move, running deploy again, makes the hole deeper.
 *
 * Recovering takes four steps in one order, and the order is the whole point:
 * roles must be reprovisioned after the schema exists and before migrations
 * run, because the authentication migration needs app_resolver to hold CREATE
 * on schema public before it can transfer ownership of the SECURITY DEFINER
 * functions. A documented procedure run by hand at the wrong moment is how the
 * sequence gets run out of order, and the symptom of getting it wrong looks
 * identical to the problem it was meant to fix.
 *
 * ---------------------------------------------------------------------------
 * What stops this pointing at production
 * ---------------------------------------------------------------------------
 *
 * Three checks, and the first two exist because the obvious version of this
 * guard does nothing at all.
 *
 * Comparing the target against DATABASE_URL is circular: the target *is*
 * DATABASE_URL, so the check passes by construction and any environment
 * override redirects the nuke while still looking guarded. Confirmed by
 * pointing this script at a made-up "production_db" — it sailed past the
 * comparison and only stopped because the database did not exist.
 *
 * So the connection string is read from the .env file on disk with
 * dotenv.parse, never from process.env. An exported DATABASE_URL cannot reach
 * this script, which is the property the circular version was pretending to
 * have.
 *
 * Then two conditions, both required. The host must be loopback, and the
 * database must be named whatsapp_os or whatsapp_os_test.
 *
 * Neither is sufficient alone. "A production database is not on your machine"
 * is comfortable and false: kubectl port-forward and SSH tunnels put one on
 * localhost:5432 as a matter of routine, which is precisely how an engineer
 * reaches production. And nothing stops a remote database from being called
 * whatsapp_os. Together they are hard to satisfy by accident.
 */

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

if (process.env["NODE_ENV"] === "production") {
  console.error("Refusing to run with NODE_ENV=production.");
  process.exit(1);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/**
 * The only two databases this script may ever touch, by name.
 *
 * Literal names, not a name derived from DATABASE_URL — deriving is what made
 * the first version of this guard tautological. Renaming the development
 * database means editing this line, which is the point.
 */
const NUKEABLE_DATABASES = new Set(["whatsapp_os", TEST_DATABASE_NAME]);

/* From the file, never from process.env — see the header. */
const envPath = path.resolve(packageRoot, "..", "..", ".env");

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

/*
 * The target is mandatory, and positional rather than a flag.
 *
 * Both halves are scar tissue. `npm run db:nuke -- --test` reaches this script
 * as no arguments at all: npm treats a leading `--test` as one of its own
 * config flags, warns "Unknown cli config", and drops it — so a run that asked
 * for the test database silently rebuilt the development one. A positional
 * word survives that. Requiring it means the same accident now refuses instead
 * of quietly choosing.
 */
const target = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

if (target !== "dev" && target !== "test") {
  console.error(
    "Usage: npm run db:nuke -- dev | test\n\n" +
      "The target is required. This drops and rebuilds a database, so there " +
      "is no default worth guessing at.",
  );
  process.exit(1);
}

const targetUrl =
  target === "test" ? withDatabase(declaredUrl, TEST_DATABASE_NAME) : declaredUrl;

const parsedTarget = new URL(targetUrl);
const targetName = parsedTarget.pathname.replace(/^\//, "");

/*
 * Both conditions, never either.
 *
 * Loopback alone is not enough: kubectl port-forward and SSH tunnels put
 * production databases on localhost every day, and that is the ordinary way an
 * engineer reaches one. "A production database is not on your machine" is a
 * comfortable assumption rather than a true one.
 *
 * The name alone is not enough either: nothing stops a remote database from
 * being called whatsapp_os.
 */
if (!LOOPBACK.has(parsedTarget.hostname)) {
  console.error(
    `Refusing to nuke a database on "${parsedTarget.hostname}".\n\n` +
      "This rebuilds local development databases only.",
  );
  process.exit(1);
}

if (!NUKEABLE_DATABASES.has(targetName)) {
  console.error(
    `Refusing to nuke "${targetName}".\n\n` +
      `Only ${[...NUKEABLE_DATABASES].join(" and ")} may be rebuilt this way.`,
  );
  process.exit(1);
}

function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

console.log(`Rebuilding "${targetName}". Everything in it will be lost.`);

const client = new pg.Client({ connectionString: targetUrl });
await client.connect();

try {
  const { rows } = await client.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  console.log(`  connected to ${rows[0].database} as ${rows[0].role}`);

  /*
   * CASCADE, because the schema is full of tables, and IF EXISTS because the
   * state this recovers from sometimes has no schema public at all.
   */
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");

  /*
   * AUTHORIZATION is explicit rather than implied by the connected role. Owning
   * schema public is what lets whatsapp_owner create tables in it, and being
   * vague about that here is the exact failure this script exists to undo.
   */
  await client.query(`CREATE SCHEMA public AUTHORIZATION ${rows[0].role}`);
  console.log("  schema public recreated");
} finally {
  await client.end();
}

/* Roles and per-database grants, before migrations. Order matters — see above. */
run(process.execPath, [path.join(packageRoot, "scripts", "db-roles.mjs")], {});

/*
 * Prisma resolved through the module system and run on this Node binary, not
 * through a shell: `shell: true` concatenates arguments without escaping them
 * (Node DEP0190) for no benefit.
 */
const require = createRequire(import.meta.url);
run(
  process.execPath,
  [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
  { DATABASE_URL: targetUrl },
);

console.log(`\n"${targetName}" is rebuilt and migrated.`);

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
