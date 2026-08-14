import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { hashToken } from "@whatsapp-os/core";
import { AuditAction, resolveCompany, withCompany } from "@whatsapp-os/db";
import { auditWithin } from "./audit.ts";
import {
  LoginScope,
  checkLocked,
  recordFailure,
} from "./lockout.ts";

/**
 * Self-service password reset.
 *
 * Keyed on the email address, which is globally unique precisely so this works
 * without a company selector — the same reason usernames are globally unique
 * for sign-in.
 */

/** One hour. Deliberately shorter than the 24h verification token. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1_000;

/** Reset requests allowed per email address before that address is throttled. */
export const MAX_RESETS_PER_EMAIL = 5;

/** Sentinel username for the per-address counter. '@' cannot occur in a real one. */
export const RESET_IP_SENTINEL = "@reset";

export interface ResetRequest {
  /** Present only when the address matched. The caller mails it, nothing else. */
  token?: string;
  email: string;
  userId?: string;
  companyId?: string;
}

/**
 * Issue a reset token for an email address, if it belongs to anyone.
 *
 * ---------------------------------------------------------------------------
 * The caller must respond identically either way
 * ---------------------------------------------------------------------------
 *
 * This returns a token or does not, and the action above it sends the same
 * page in both cases. "No account with that email" turns the reset form into a
 * membership oracle for every address an attacker cares to try — which is worse
 * here than at sign-in, because there is no password to guess and no lockout to
 * hit.
 *
 * Throttled on two keys, because they stop different things: per address, so
 * one mailbox cannot be flooded from a botnet; per IP, so one client cannot
 * enumerate addresses by timing or by volume.
 */
export async function requestPasswordReset(
  email: string,
  ip: string,
): Promise<ResetRequest> {
  const normalised = email.trim().toLowerCase();

  const [byEmail, byAddress] = await Promise.all([
    checkLocked(normalised, "*", LoginScope.PASSWORD_RESET),
    checkLocked(RESET_IP_SENTINEL, ip, LoginScope.PASSWORD_RESET),
  ]);

  if (byEmail.locked || byAddress.locked) {
    /* Throttled. Same shape as a miss — the caller cannot tell, and neither
       can the requester. */
    return { email: normalised };
  }

  /* Counted before the lookup, so a miss costs the same as a hit. */
  await recordFailure(normalised, "*", LoginScope.PASSWORD_RESET);
  await recordFailure(RESET_IP_SENTINEL, ip, LoginScope.PASSWORD_RESET);

  const companyId = await resolveCompany("email", normalised);
  if (!companyId) return { email: normalised };

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  const userId = await withCompany(companyId, async (db, scoped) => {
    const user = await db.user.findUnique({
      where: { email: normalised },
      select: { id: true },
    });
    if (!user) return null;

    /*
     * Older links are spent. Otherwise every request widens the window instead
     * of moving it, and a link from an hour ago still works.
     */
    await db.passwordResetToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await db.passwordResetToken.create({
      data: { companyId: scoped, userId: user.id, tokenHash, expiresAt },
    });

    await auditWithin(db, scoped, {
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      userId: user.id,
      ip,
      metadata: { origin: "self_service" },
    });

    return user.id;
  });

  if (!userId) return { email: normalised };

  return { token, email: normalised, userId, companyId };
}

export type ResetTokenLookup =
  | { ok: true; companyId: string; userId: string }
  | { ok: false };

/**
 * Check a token without spending it, for rendering the form.
 *
 * Separate from consumption so an expired link shows a useful page instead of
 * burning the token to find out.
 */
export async function inspectResetToken(
  rawToken: string,
): Promise<ResetTokenLookup> {
  if (!rawToken) return { ok: false };

  const tokenHash = hashToken(rawToken);
  const companyId = await resolveCompany("password_reset", tokenHash);
  if (!companyId) return { ok: false };

  return withCompany(companyId, async (db, scoped) => {
    const token = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { userId: true, consumedAt: true, expiresAt: true },
    });

    if (!token || token.consumedAt || token.expiresAt <= new Date()) {
      return { ok: false } as const;
    }

    return { ok: true, companyId: scoped, userId: token.userId } as const;
  });
}

/**
 * Spend a token, atomically.
 *
 * updateManyAndReturn compiles to UPDATE ... WHERE ... RETURNING, so two
 * concurrent submissions of the same link contend on the row and exactly one
 * comes back with it. A read-then-write would let both through.
 */
export async function consumeResetToken(
  rawToken: string,
): Promise<ResetTokenLookup> {
  if (!rawToken) return { ok: false };

  const tokenHash = hashToken(rawToken);
  const companyId = await resolveCompany("password_reset", tokenHash);
  if (!companyId) return { ok: false };

  return withCompany(companyId, async (db, scoped) => {
    const consumed = await db.passwordResetToken.updateManyAndReturn({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    const token = consumed[0];
    if (!token) return { ok: false } as const;

    return { ok: true, companyId: scoped, userId: token.userId } as const;
  });
}

/** Kill every live session for a user. Used by the admin-issued reset. */
export async function revokeAllSessions(
  companyId: string,
  userId: string,
): Promise<number> {
  return withCompany(companyId, async (db) => {
    const { count } = await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  });
}
