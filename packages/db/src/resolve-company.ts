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

/**
 * "webhook" is the odd one out, in a way worth knowing before using it.
 *
 * Every other kind asks "may this person act", and refuses a deactivated
 * company. That one asks "did this third party tell us something true", and
 * resolves for a deactivated company on purpose — Meta disables a subscription
 * that fails for about a week, so refusing here would silently cost the tenant
 * their webhook and every message sent while they were suspended. The refusal
 * belongs in the worker, which records the delivery and declines to act.
 *
 * It also matches only WHATSAPP_CLOUD integrations. Every integration has a
 * webhook_key, including Sheets and Ads, and resolving one of those would open
 * the right company and then fail looking for credentials never stored.
 *
 * See 20260815120000_resolve_company_by_webhook.
 *
 * "lead_source" is the seventh kind and the opposite of that one on the very
 * point above: it DOES refuse a deactivated company. The asymmetry is
 * deliberate both times. A WhatsApp webhook resolves for a suspended tenant
 * because refusing costs them their Meta subscription and every message that
 * arrived while they were suspended - evidence, which suspension should not
 * discard. A lead-source ping only ever causes us to SEND, a suspended
 * workspace must not send, and Google Apps Script has no subscription to lose:
 * it rings again the moment the sheet is next edited.
 *
 * See 20260903090000_lead_source_webhook_key.
 */
export type ResolveKind =
  | "username"
  | "email"
  | "session"
  | "verification"
  | "password_reset"
  | "webhook"
  | "lead_source";

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
