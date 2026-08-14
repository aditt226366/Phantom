import pg from "pg";
import { maintenanceDatabaseUrl } from "./db-urls.mjs";

/**
 * Grant LOGIN and a password to the application roles.
 *
 * The roles themselves are created by a migration, without a password, so the
 * committed SQL carries no secret. This script supplies the credential half.
 * It is idempotent and safe to re-run.
 *
 *     npm run db:roles
 *
 * In production, do not run this. Set the passwords from your secrets manager:
 *
 *     ALTER ROLE app_runtime LOGIN PASSWORD '...';
 *     ALTER ROLE app_admin   LOGIN PASSWORD '...';
 *
 * which is why this refuses to run with NODE_ENV=production.
 */

if (process.env["NODE_ENV"] === "production") {
  console.error(
    "Refusing to run with NODE_ENV=production.\n" +
      "Set the role passwords from your secrets manager instead:\n" +
      "  ALTER ROLE app_runtime LOGIN PASSWORD '...';\n" +
      "  ALTER ROLE app_admin   LOGIN PASSWORD '...';",
  );
  process.exit(1);
}

const ROLES = [
  { name: "app_runtime", password: process.env["APP_DB_PASSWORD"] ?? "app_runtime" },
  { name: "app_admin", password: process.env["ADMIN_DB_PASSWORD"] ?? "app_admin" },
];

const client = new pg.Client({ connectionString: maintenanceDatabaseUrl() });
await client.connect();

try {
  for (const role of ROLES) {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role.name],
    );

    if (rowCount === 0) {
      // Roles are cluster-wide, so this happens only when db:roles runs before
      // any migration has been applied. Create it here; the migration's
      // IF NOT EXISTS will then skip.
      await client.query(`CREATE ROLE ${quoteIdent(role.name)} NOLOGIN`);
      console.log(`Created role ${role.name}.`);
    }

    await client.query(
      `ALTER ROLE ${quoteIdent(role.name)} LOGIN PASSWORD ${quoteLiteral(role.password)}`,
    );
    console.log(`${role.name}: LOGIN granted.`);
  }
} finally {
  await client.end();
}

/**
 * ALTER ROLE accepts no bind parameters for identifiers or passwords, so both
 * are quoted by hand. Doubling the delimiter is exactly what Postgres'
 * quote_ident / quote_literal do.
 */
function quoteIdent(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
