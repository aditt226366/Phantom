import "server-only";
import { createHmac } from "node:crypto";
import {
  generateCsrfSecret,
  hashToken,
  issueSessionToken,
} from "@whatsapp-os/core";
import {
  resolveCompany,
  withCompany,
  type CompanyClient,
} from "@whatsapp-os/db";

/**
 * Session records, as database operations.
 *
 * Kept separate from session.ts on purpose: everything here is a pure function
 * of its arguments, with no dependency on `next/headers`. That is what makes it
 * testable outside a request — the cookie layer is a thin wrapper on top, and
 * the interesting behaviour (tenant resolution, expiry, revocation, rolling
 * renewal) lives here where a test can reach it.
 */

/** How stale lastSeenAt must be before a session is extended. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface SessionContext {
  sessionId: string;
  companyId: string;
  userId: string;
  csrfSecret: string;
  expiresAt: Date;
  user: {
    id: string;
    fullName: string;
    email: string;
    username: string;
    phoneE164: string;
    emailVerifiedAt: Date | null;
    role: string;
  };
  /**
   * Loaded here rather than by the shell.
   *
   * The layout needs the company name and every page needs the session, so
   * fetching them separately would mean two interactive transactions per
   * request — each holding a pooled connection — to read two rows that are one
   * join apart. Included in this query, the whole request costs one.
   */
  company: {
    id: string;
    name: string;
    slug: string;
  };
}

export interface SessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Hash an IP before storing it.
 *
 * An unsalted digest of an IPv4 address is not anonymisation — the whole
 * keyspace is four billion entries and reverses in seconds. Keying the HMAC
 * with the application secret means the stored value is only correlatable by
 * something that already holds the key.
 */
function hashIp(ip: string): string {
  const key = process.env["ENCRYPTION_KEY"] ?? "";
  return createHmac("sha256", key).update(ip).digest("hex");
}

/**
 * Create a session row and return the raw token exactly once.
 *
 * The caller puts `token` in the cookie and then forgets it: only its hash is
 * stored, so nothing can recover a live session from a database dump.
 */
export async function createSessionRecord(
  companyId: string,
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; csrfSecret: string; expiresAt: Date }> {
  return withCompany(companyId, (db, scopedCompanyId) =>
    createSessionRow(db, scopedCompanyId, userId, meta),
  );
}

/**
 * Create a session inside a transaction the caller already opened.
 *
 * Signup needs this: the company, the owner user, the verification token, the
 * session and the audit rows all have to commit or none of them. Calling
 * createSessionRecord there would open a second, independent transaction, and
 * a failure between the two would leave an account nobody is signed in to.
 */
export async function createSessionRow(
  db: CompanyClient,
  companyId: string,
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; csrfSecret: string; expiresAt: Date }> {
  const { token, tokenHash, expiresAt } = issueSessionToken();
  const csrfSecret = generateCsrfSecret();

  await db.session.create({
    data: {
      companyId,
      userId,
      tokenHash,
      csrfSecret,
      expiresAt,
      ...(meta.ip ? { ipHash: hashIp(meta.ip) } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
    },
  });

  return { token, csrfSecret, expiresAt };
}

/**
 * Resolve a raw cookie token to a session, or null.
 *
 * The two-step lookup is the whole point. resolveCompany turns an opaque token
 * into a company id through a SECURITY DEFINER function that returns an id and
 * nothing else; only then is a company context opened and the row read under
 * normal RLS.
 *
 * The company id therefore comes *from the database*, derived from a token the
 * caller already held. It is never taken from anything the client sent — a
 * company id from a request parameter handed to withCompany would bypass every
 * policy in the system.
 */
export async function resolveSessionByToken(
  rawToken: string,
): Promise<SessionContext | null> {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const companyId = await resolveCompany("session", tokenHash);
  if (!companyId) return null;

  return withCompany(companyId, async (db) => {
    const session = await db.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            username: true,
            phoneE164: true,
            emailVerifiedAt: true,
            role: true,
          },
        },
        company: { select: { id: true, name: true, slug: true } },
      },
    });

    /*
     * resolveCompany already filters on revoked_at and expires_at, so reaching
     * here with a dead session should be impossible. Re-checked anyway: this is
     * the last gate before a request is treated as authenticated, and it costs
     * a comparison.
     */
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    /*
     * Rolling renewal, but not on every request. Writing a row per request
     * turns every page view into a database write and every session into a
     * write-contention hotspot for no benefit — a day's granularity is
     * indistinguishable to the user across a 30-day window.
     */
    const stale = Date.now() - session.lastSeenAt.getTime() > RENEW_AFTER_MS;
    if (stale) {
      const { expiresAt } = issueSessionToken();
      await db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt },
      });
    }

    return {
      sessionId: session.id,
      companyId: session.companyId,
      userId: session.userId,
      csrfSecret: session.csrfSecret,
      expiresAt: session.expiresAt,
      user: session.user,
      company: session.company,
    };
  });
}

/** Revoke immediately. Server-side sessions exist so logout is not advisory. */
export async function revokeSessionByToken(rawToken: string): Promise<void> {
  if (!rawToken) return;

  const tokenHash = hashToken(rawToken);
  const companyId = await resolveCompany("session", tokenHash);
  if (!companyId) return;

  await withCompany(companyId, (db) =>
    db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

/**
 * Delete dead sessions for one company.
 *
 * Scoped to a company rather than global, and that is a consequence of the
 * security model rather than an oversight: app_runtime with no company context
 * matches no RLS policy, so a global `DELETE FROM sessions WHERE expires_at <
 * now()` deletes exactly nothing. A cluster-wide sweep needs a credential that
 * can see across companies, which belongs in the worker with admin
 * credentials, not on a request path.
 *
 * Nothing depends on this for correctness — an expired session is already
 * refused by resolveSessionByToken and by the resolver's own filter. This is
 * housekeeping.
 */
export async function sweepExpiredSessions(companyId: string): Promise<number> {
  return withCompany(companyId, async (db) => {
    const { count } = await db.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  });
}
