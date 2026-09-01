import pg from "pg";
import { managedDatabaseNames, superuserDatabaseUrl } from "./db-urls.mjs";

/**
 * Provision the database roles. Idempotent; safe to re-run at any time.
 *
 *     npm run db:roles
 *
 * This is the one place in the codebase that connects as the cluster
 * superuser, because creating roles and transferring table ownership are the
 * only operations that genuinely require it. Everything else — migrations
 * included — runs as whatsapp_owner.
 *
 * ---------------------------------------------------------------------------
 * Why three roles
 * ---------------------------------------------------------------------------
 *
 *   whatsapp_owner  owns the tables, runs migrations.  NOSUPERUSER NOBYPASSRLS
 *   app_runtime     every application query.           owns nothing
 *   app_admin       the platform admin panel.          owns nothing
 *
 * The container superuser used to own the tables, and that quietly defeated
 * the point of FORCE ROW LEVEL SECURITY: superusers bypass RLS unconditionally,
 * so the FORCE clause could never be observed to do anything locally. With a
 * plain owner role, "the owner sees nothing without a company context" becomes
 * a testable claim — see the owner-connection test in rls-isolation.test.ts.
 *
 * whatsapp_owner needs CREATEDB for two real reasons: `prisma migrate dev`
 * provisions a shadow database, and migrate-test.mjs creates whatsapp_os_test.
 *
 * ---------------------------------------------------------------------------
 * Production
 * ---------------------------------------------------------------------------
 *
 * Do not run this. Create the roles once from your secrets manager, with the
 * same attributes, and never hand the application DATABASE_URL. Note that
 * app_admin is deliberately not BYPASSRLS: that attribute requires a real
 * superuser to grant, which RDS, Supabase and Neon do not provide, so the role
 * would simply be uncreatable. It gets an explicit per-table policy instead.
 */

if (process.env["NODE_ENV"] === "production") {
  console.error(
    "Refusing to run with NODE_ENV=production. Provision roles from your " +
      "secrets manager instead; see the header of this file.",
  );
  process.exit(1);
}

const ROLES = [
  {
    name: "whatsapp_owner",
    password: process.env["OWNER_DB_PASSWORD"] ?? "whatsapp_owner",
    attributes: "NOSUPERUSER NOBYPASSRLS CREATEDB LOGIN",
  },
  {
    name: "app_runtime",
    password: process.env["APP_DB_PASSWORD"] ?? "app_runtime",
    attributes: "NOSUPERUSER NOBYPASSRLS NOCREATEDB LOGIN",
  },
  {
    name: "app_admin",
    password: process.env["ADMIN_DB_PASSWORD"] ?? "app_admin",
    attributes: "NOSUPERUSER NOBYPASSRLS NOCREATEDB LOGIN",
  },
  {
    /*
     * Owns the SECURITY DEFINER lookup functions and nothing else.
     *
     * Sign-in is username + password with no company selector, so the username
     * lookup, the session-cookie lookup and the slug-collision check all have
     * to happen before any company context exists. Rather than make users or
     * sessions globally readable to solve that, this role holds SELECT-only
     * policies on exactly those tables, and app_runtime is granted EXECUTE on
     * functions that return a company id and nothing else.
     *
     * NOLOGIN: nothing can ever connect as it. Its privileges are reachable
     * only by calling one of those functions.
     */
    name: "app_resolver",
    password: null,
    attributes: "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOLOGIN",
  },
];

/**
 * ALTER ROLE accepts no bind parameters for identifiers or passwords, so both
 * are quoted by hand — exactly what quote_ident / quote_literal do.
 */
function quoteIdent(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/* ------------------------------------------------------------------ */
/* 1. Roles (cluster-wide, so this happens once)                       */
/* ------------------------------------------------------------------ */

const superuserUrl = superuserDatabaseUrl();
const cluster = await connect(superuserUrl);

try {
  for (const role of ROLES) {
    const { rowCount } = await cluster.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role.name],
    );

    if (rowCount === 0) {
      await cluster.query(`CREATE ROLE ${quoteIdent(role.name)}`);
      console.log(`Created role ${role.name}.`);
    }

    /* Re-applied every run: attributes are as load-bearing as the password. */
    const credential = role.password
      ? ` PASSWORD ${quoteLiteral(role.password)}`
      : "";
    await cluster.query(
      `ALTER ROLE ${quoteIdent(role.name)} ${role.attributes}${credential}`,
    );
    console.log(`${role.name}: ${role.attributes}.`);
  }

  /*
   * whatsapp_owner must be a member of app_resolver to create functions owned
   * by it. WITH INHERIT FALSE is the load-bearing part: without it, the owner
   * would inherit app_resolver's SELECT policies and the "owner sees nothing"
   * test — the only direct proof FORCE ROW LEVEL SECURITY works — would start
   * passing for the wrong reason. Membership still permits SET ROLE, which is
   * all the migration needs. (Requires PostgreSQL 16+.)
   */
  await cluster.query(
    "GRANT app_resolver TO whatsapp_owner WITH INHERIT FALSE",
  );
  console.log("app_resolver: granted to whatsapp_owner WITH INHERIT FALSE.");
} finally {
  await cluster.end();
}

/* ------------------------------------------------------------------ */
/* 2. Per-database ownership and privileges                            */
/* ------------------------------------------------------------------ */

for (const database of managedDatabaseNames()) {
  const exists = await connect(superuserUrl);
  let present;
  try {
    const { rowCount } = await exists.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    present = rowCount > 0;
  } finally {
    await exists.end();
  }

  if (!present) {
    console.log(`${database}: does not exist yet, skipping.`);
    continue;
  }

  const url = new URL(superuserUrl);
  url.pathname = `/${database}`;
  const db = await connect(url.toString());

  try {
    /*
     * pgvector, created HERE because a migration cannot create it.
     *
     * ---------------------------------------------------------------------
     * Why this is not in the migration that needs it
     * ---------------------------------------------------------------------
     *
     * Migrations run as whatsapp_owner, which is NOSUPERUSER by rule 1. The
     * `vector` extension is not marked trusted in the pgvector image, so
     * CREATE EXTENSION requires an actual superuser:
     *
     *     ERROR:  permission denied to create extension "vector"
     *     HINT:   Must be superuser to create this extension.
     *
     * Putting it in the Phase 9 migration therefore produces a migration that
     * cannot be applied by the role that applies migrations - and it fails on
     * a FRESH database only, so it would pass locally for anybody whose
     * extension already existed and fail for every new clone.
     *
     * This script is the one place that legitimately holds superuser, and it
     * already runs at exactly the right moment: after the database exists and
     * BEFORE `migrate deploy`, which is the ordering db-nuke.mjs documents at
     * length. The same argument the default-privileges cleanup below makes.
     *
     * IF NOT EXISTS, so re-running is a no-op - this script is idempotent by
     * contract and is run by db:setup, db:nuke and the test bootstrap.
     */
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");

    /*
     * app_resolver needs CREATE, not just USAGE: Postgres requires the *new*
     * owner of an object to hold CREATE on the schema containing it, so
     * `ALTER FUNCTION ... OWNER TO app_resolver` fails without it.
     */
    await db.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO whatsapp_owner, app_resolver`,
    );
    await db.query("GRANT USAGE ON SCHEMA public TO app_runtime, app_admin");

    /*
     * Transfer ownership object by object, in schema public only.
     *
     * REASSIGN OWNED BY would be shorter and is the wrong tool here: the
     * container's POSTGRES_USER is this cluster's *bootstrap* superuser, so it
     * also owns the system catalogs, the template databases and the postgres
     * database itself. Reassigning all of that is not a thing to do.
     */
    const { rows: moved } = await db.query(`
      DO $$
      DECLARE obj record;
      BEGIN
        FOR obj IN
          SELECT tablename AS name FROM pg_tables
          WHERE schemaname = 'public' AND tableowner <> 'whatsapp_owner'
        LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO whatsapp_owner', obj.name);
        END LOOP;

        FOR obj IN
          SELECT sequencename AS name FROM pg_sequences
          WHERE schemaname = 'public' AND sequenceowner <> 'whatsapp_owner'
        LOOP
          EXECUTE format('ALTER SEQUENCE public.%I OWNER TO whatsapp_owner', obj.name);
        END LOOP;

        /*
         * app_resolver-owned functions are excluded, and that exclusion is
         * load-bearing. The SECURITY DEFINER lookup functions run as their
         * owner; reassigning them to whatsapp_owner would leave them running
         * as a role that FORCE ROW LEVEL SECURITY gives no visibility to, so
         * every username and session lookup would start returning NULL and
         * sign-in would fail with nothing in the logs to explain it.
         */
        FOR obj IN
          SELECT p.oid::regprocedure AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proowner NOT IN (
              'whatsapp_owner'::regrole,
              'app_resolver'::regrole
            )
        LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO whatsapp_owner', obj.name);
        END LOOP;
      END $$;

      SELECT count(*)::int AS remaining FROM pg_tables
      WHERE schemaname = 'public' AND tableowner <> 'whatsapp_owner';
    `);

    /*
     * Drop the stale default privileges bound to the previous creating role.
     * ALTER DEFAULT PRIVILEGES is keyed to whoever CREATES the object, so the
     * entries left over from when the superuser ran migrations now describe a
     * situation that can no longer occur. Removing them keeps pg_default_acl
     * honest about what actually happens. Superuser-only, hence here rather
     * than in a migration; the replacement entries are created by the
     * migration, running as whatsapp_owner.
     */
    const superuserName = new URL(superuserUrl).username;
    if (superuserName && superuserName !== "whatsapp_owner") {
      await db.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(superuserName)} IN SCHEMA public
           REVOKE ALL ON TABLES FROM app_runtime, app_admin`,
      );
      await db.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(superuserName)} IN SCHEMA public
           REVOKE ALL ON SEQUENCES FROM app_runtime, app_admin`,
      );
    }

    const remaining = moved?.[0]?.remaining ?? 0;
    console.log(
      `${database}: public objects owned by whatsapp_owner ` +
        `(${remaining} still not owned).`,
    );
  } finally {
    await db.end();
  }
}
