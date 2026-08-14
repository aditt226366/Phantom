import "server-only";
import {
  checkPasswordBreached,
  hashPassword,
  isCommonPassword,
} from "@whatsapp-os/core";
import { AuditAction, withCompany } from "@whatsapp-os/db";
import { auditWithin } from "./audit.ts";

/**
 * The one place a password is ever written.
 *
 * Three entry points reach it — an authenticated change, a self-service reset,
 * and an admin-issued reset — and all three must do the same six things or the
 * weakest becomes the way in. Duplicating that across three call sites is how a
 * reset path ends up not revoking sessions.
 *
 *   1. denylist        cheap, offline, runs first
 *   2. breach check    network, before any transaction
 *   3. argon2          CPU, before any transaction
 *   4. write the hash, stamp passwordChangedAt and hibpCheckedAt
 *   5. revoke every session for the user, including the caller's
 *   6. audit
 *
 * ---------------------------------------------------------------------------
 * A breached password is REFUSED here, unlike at sign-in
 * ---------------------------------------------------------------------------
 *
 * At sign-in a hit is advisory: the user already has the password, and locking
 * them out of their own account leaves them no route to fix it. Here they are
 * choosing a new one, so refusing costs them nothing but a second attempt. Same
 * check, opposite answer, because the situations are opposite.
 *
 * ---------------------------------------------------------------------------
 * Every session dies, including the one asking
 * ---------------------------------------------------------------------------
 *
 * A password change is the action taken after "someone else may have my
 * account". Leaving other sessions alive would make it ceremonial. The change
 * flow issues a fresh session afterwards so the user is not signed out of the
 * page they are standing on; the reset flows do not, because there is nobody
 * signed in to keep.
 */

export type SetPasswordReason = "change" | "reset" | "admin_reset";

export type SetPasswordResult =
  | { ok: true; breachCheckSkipped: boolean }
  | { ok: false; reason: "password_common" | "password_breached" };

export interface SetPasswordContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function setPassword(
  companyId: string,
  userId: string,
  plaintext: string,
  reason: SetPasswordReason,
  context: SetPasswordContext = {},
): Promise<SetPasswordResult> {
  if (isCommonPassword(plaintext)) {
    return { ok: false, reason: "password_common" };
  }

  const breach = await checkPasswordBreached(plaintext);
  if (breach.checked && breach.breached) {
    return { ok: false, reason: "password_breached" };
  }

  const passwordHash = await hashPassword(plaintext);
  const now = new Date();

  await withCompany(companyId, async (db, scoped) => {
    await db.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        /*
         * Only stamped when the check completed. A failed lookup leaves it
         * null so the deferred re-check at next sign-in fires — the same rule
         * as signup, for the same reason.
         */
        ...(breach.checked ? { hibpCheckedAt: now } : { hibpCheckedAt: null }),
        /* The flag described the old password. */
        passwordBreachedAt: null,
      },
    });

    /*
     * Everything, with no exception for the caller. The change flow mints a
     * replacement immediately afterwards.
     */
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    /* Any outstanding reset links are spent too — the password is already set. */
    await db.passwordResetToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });

    await auditWithin(db, scoped, {
      action: AuditAction.PASSWORD_CHANGED,
      userId,
      ...context,
      metadata: { reason },
    });

    if (!breach.checked) {
      await auditWithin(db, scoped, {
        action: AuditAction.HIBP_UNAVAILABLE,
        userId,
        ...context,
        metadata: { reason: breach.reason, at: `set_password:${reason}` },
      });
    }
  });

  return { ok: true, breachCheckSkipped: !breach.checked };
}
