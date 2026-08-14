import pg from "pg";
import { testAppDatabaseUrl, testDatabaseUrl } from "../scripts/db-urls.mjs";
import { createCompany, newCompanyId, withCompany } from "../src/index.ts";

/**
 * Test fixtures.
 *
 * Note what does the seeding: withCompany, the real code path, not a
 * privileged back door. Seeding as the owner would work locally (the dev owner
 * is a superuser) and then fail anywhere the owner is not, because FORCE ROW
 * LEVEL SECURITY subjects the owner to policies that are scoped to app_runtime.
 * Using the real path keeps the fixtures honest about what the system allows.
 *
 * The owner connection is used for exactly one thing — TRUNCATE, which ignores
 * RLS and which app_runtime is deliberately not granted.
 */

export interface SeededCompany {
  id: string;
  slug: string;
  userIds: string[];
  usernames: string[];
}

/**
 * Wipe every table. Runs as the owner; TRUNCATE bypasses RLS by design.
 *
 * Discovered rather than listed: a hardcoded list silently stops covering the
 * next table someone adds, and the residue shows up as a confusing failure in
 * an unrelated test.
 */
export async function truncateAll(): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();

  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );

    if (rows.length === 0) return;

    const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}

/**
 * A raw client on the runtime role with no withCompany wrapper and no
 * extension — the "someone bypassed the application layer" client.
 *
 * Pool size 1 so that connection reuse is guaranteed rather than incidental:
 * the GUC-leak test depends on getting the same physical connection back.
 */
export function rawRuntimeClient(): pg.Pool {
  return new pg.Pool({ connectionString: testAppDatabaseUrl(), max: 1 });
}

/**
 * A client connected as whatsapp_owner — the role that OWNS these tables.
 *
 * Postgres exempts a table's owner from its own policies unless FORCE ROW
 * LEVEL SECURITY is set, so this connection is the only direct way to observe
 * whether FORCE is doing anything. It only became a meaningful test once the
 * owner stopped being the container superuser: superusers bypass RLS
 * unconditionally, FORCE or not, so the assertion would have been vacuous.
 */
export function ownerClient(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
}

/**
 * Create a company and `userCount` users inside it, through the real path.
 *
 * `label` seeds the company name and the users' unique fields; the slug is
 * allocated by the same code signup uses, so it is not necessarily the label.
 */
export async function seedCompany(
  label: string,
  userCount = 2,
): Promise<SeededCompany> {
  const id = newCompanyId();
  const usernames: string[] = [];

  const { slug, userIds } = await withCompany(id, async (db, companyId) => {
    const company = await createCompany(db, companyId, `${label} Ltd`);

    const created: string[] = [];
    for (let index = 0; index < userCount; index++) {
      const username = `${label}_user${index}`;
      const user = await db.user.create({
        data: {
          companyId,
          fullName: `${label} ${index}`,
          email: `user${index}@${label}.test`,
          username,
          passwordHash: "$argon2id$placeholder",
          phoneE164: `+9198765432${index}0`,
          role: index === 0 ? "OWNER" : "MEMBER",
        },
      });
      created.push(user.id);
      usernames.push(username);
    }

    return { slug: company.slug, userIds: created };
  });

  return { id, slug, userIds, usernames };
}
