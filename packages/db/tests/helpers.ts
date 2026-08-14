import pg from "pg";
import { testAppDatabaseUrl, testDatabaseUrl } from "../scripts/db-urls.mjs";
import { newCompanyId, withCompany } from "../src/index.ts";

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
}

/** Wipe every table. Runs as the owner; TRUNCATE bypasses RLS by design. */
export async function truncateAll(): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();

  try {
    await client.query(
      `TRUNCATE TABLE "users", "companies" RESTART IDENTITY CASCADE`,
    );
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

/** Create a company and `userCount` users inside it, through the real path. */
export async function seedCompany(
  slug: string,
  userCount = 2,
): Promise<SeededCompany> {
  const id = newCompanyId();

  const userIds = await withCompany(id, async (db, companyId) => {
    await db.company.create({
      data: { id: companyId, slug, name: `${slug} Ltd` },
    });

    const created: string[] = [];
    for (let index = 0; index < userCount; index++) {
      const user = await db.user.create({
        data: {
          companyId,
          email: `user${index}@${slug}.test`,
          name: `${slug} ${index}`,
        },
      });
      created.push(user.id);
    }
    return created;
  });

  return { id, slug, userIds };
}
