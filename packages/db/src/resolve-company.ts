import { prisma } from "./client.ts";

/**
 * Map one opaque key to one company id, before any company context exists.
 *
 * Sign-in is username + password with no company selector, so the username
 * lookup and the session-cookie lookup both have to happen before there is a
 * company to scope them to. This is the only sanctioned way to do that.
 *
 *     const companyId = await resolveCompany("session", sha256(cookie));
 *     if (!companyId) return null;                       // anonymous
 *     return withCompany(companyId, (db) => db.session.findUnique({ ... }));
 *
 * It calls a SECURITY DEFINER function owned by app_resolver, which holds
 * SELECT-only policies on the three lookup tables. The entire cross-company
 * capability granted to the application is this: a single text value out, never
 * a row. Everything after the lookup goes back through normal RLS.
 *
 * ---------------------------------------------------------------------------
 * The rule that makes this safe
 * ---------------------------------------------------------------------------
 *
 * The id returned here came *from the database*, derived from an opaque key the
 * caller already possessed. That is what makes it safe to hand to withCompany.
 *
 * A company id that came from a request — a query parameter, a form field, a
 * header — is not safe and never becomes safe. `withCompany(req.query.companyId)`
 * is a complete bypass of every policy in this system, because withCompany sets
 * the value the policies trust. There are exactly two places company ids are
 * allowed to originate: this function, and the session row.
 *
 * This module and packages/db/src/company.ts are the only sanctioned raw-SQL
 * sites in the codebase.
 */

export type ResolveKind =
  | "username"
  | "email"
  | "session"
  | "verification"
  | "password_reset";

export async function resolveCompany(
  kind: ResolveKind,
  key: string,
): Promise<string | null> {
  if (!key) return null;

  const rows = await prisma.$queryRaw<Array<{ company_id: string | null }>>`
    SELECT app_resolve_company(${kind}, ${key}) AS company_id
  `;

  return rows[0]?.company_id ?? null;
}
