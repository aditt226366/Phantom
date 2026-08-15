import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AuditAction, withCompany } from "@whatsapp-os/db";
import { findUserForReset, writeAdminAudit } from "@/lib/admin-db";
import { auditWithin } from "./audit.ts";
import { RESET_TOKEN_TTL_MS, revokeAllSessions } from "./password-reset.ts";

/**
 * An admin triggers a reset; the system mails the link.
 *
 * ---------------------------------------------------------------------------
 * The admin never sees the token and never sets a password
 * ---------------------------------------------------------------------------
 *
 * Returning the link to the panel would let an operator take any account
 * silently — no mail sent, no trace in the user's inbox, nothing the user could
 * notice. The token goes to the address on file and the panel is told only that
 * a link was sent. That is also why there is no "set a password for this user"
 * path: an admin who can choose the credential can impersonate without leaving
 * a mark.
 *
 * Sessions are revoked immediately rather than when the link is used. The
 * reason to press this button is a suspected compromise, and waiting for the
 * user to act on an email would leave the attacker signed in in the meantime.
 */

export interface AdminResetResult {
  ok: boolean;
  /** For the mailer only. Never returned to a response body. */
  token?: string;
  email?: string;
  sessionsRevoked?: number;
  /** Set when the reset was refused for a reason worth telling the operator. */
  refused?: "company-deactivated";
}

export async function issueAdminPasswordReset(
  adminUserId: string,
  username: string,
  ip?: string,
): Promise<AdminResetResult> {
  const user = await findUserForReset(username);

  if (!user) {
    await writeAdminAudit({
      adminUserId,
      action: "admin.password_reset.not_found",
      ...(ip ? { ip } : {}),
      metadata: { username },
    });
    return { ok: false };
  }

  if (user.companyDeactivatedAt !== null) {
    /*
     * Refused here rather than in the panel, because the token would be
     * useless in a way nothing downstream reports.
     *
     * app_resolve_company() returns NULL for the 'password_reset' kind once a
     * company is deactivated, so the link would arrive in the user's inbox and
     * fail to resolve — and the operator, having seen "a link was sent", would
     * conclude that email is broken. An affordance that depends on the
     * resolver should refuse wherever the resolver refuses.
     */
    await writeAdminAudit({
      adminUserId,
      action: "admin.password_reset.refused_deactivated",
      ...(ip ? { ip } : {}),
      metadata: { username, companyId: user.companyId },
    });

    return { ok: false, refused: "company-deactivated" };
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  await withCompany(user.companyId, async (db, scoped) => {
    /* Older links are spent, so this one is the only way in. */
    await db.passwordResetToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await db.passwordResetToken.create({
      data: {
        companyId: scoped,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    await auditWithin(db, scoped, {
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      userId: user.id,
      ...(ip ? { ip } : {}),
      metadata: { origin: "admin" },
    });
  });

  const sessionsRevoked = await revokeAllSessions(user.companyId, user.id);

  /* Recorded on both sides: the tenant's audit log and the platform's. */
  await writeAdminAudit({
    adminUserId,
    action: "admin.password_reset.issued",
    ...(ip ? { ip } : {}),
    metadata: { username, companyId: user.companyId, sessionsRevoked },
  });

  return { ok: true, token, email: user.email, sessionsRevoked };
}
