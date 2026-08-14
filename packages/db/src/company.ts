import type { CompanyClient } from "./with-company.ts";

/**
 * Company creation, including slug allocation.
 *
 * The slug is derived from the name and never typed by the user, which means a
 * collision is not the user's problem to solve. Two companies can legitimately
 * be called "Acme" — telling the second one "that company name is taken" would
 * be both untrue and a disclosure that some other tenant exists. A short
 * suffix is appended instead and the signup proceeds.
 */

const MAX_SLUG_LENGTH = 48;

/**
 * Turn a company name into a URL-safe base slug.
 *
 * Unicode is normalised and stripped of combining marks first, so "Café" gives
 * "cafe" rather than "caf". A name with no usable characters at all — say, one
 * written entirely in emoji — reduces to an empty string, and
 * app_available_slug falls back to "company".
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * Create the company row for a signup.
 *
 * `companyId` must be the id the surrounding withCompany scope was opened with.
 * The RLS policy on companies only permits inserting a row whose id matches the
 * current context, which is why the id is generated before the transaction —
 * see newCompanyId() and the row-level-security migration.
 *
 * On the rare race where a concurrent signup takes the same slug between the
 * check and the insert, the unique constraint raises and the whole signup
 * should be retried.
 */
export async function createCompany(
  db: CompanyClient,
  companyId: string,
  name: string,
) {
  const rows = await db.$queryRaw<Array<{ slug: string }>>`
    SELECT app_available_slug(${slugify(name)}) AS slug
  `;

  const slug = rows[0]?.slug;
  if (!slug) {
    throw new Error(`Could not allocate a slug for company name "${name}"`);
  }

  return db.company.create({ data: { id: companyId, slug, name } });
}
