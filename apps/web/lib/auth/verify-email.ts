import "server-only";
import { hashToken, issueVerificationToken } from "@whatsapp-os/core";
import { AuditAction, resolveCompany, withCompany } from "@whatsapp-os/db";
import { auditWithin } from "./audit.ts";

/**
 * Email verification tokens.
 *
 * The link is the credential, so the token is the whole authorisation: there is
 * no session involved, and the company is resolved from the token itself.
 *
 * A token for another company simply does not resolve, and the caller returns
 * 404. Not 403 — per rule 3 in CLAUDE.md, and for the reason the rule exists: a
 * 403 confirms the token is real and merely not yours, which is a fact worth
 * withholding from someone guessing.
 */

export type ConsumeResult =
  | { ok: true; companyId: string; userId: string }
  | { ok: false; reason: "not_found" };

export async function consumeVerificationToken(
  rawToken: string,
): Promise<ConsumeResult> {
  if (!rawToken) return { ok: false, reason: "not_found" };

  const tokenHash = hashToken(rawToken);

  /*
   * The resolver already filters on consumed_at IS NULL and expires_at > now(),
   * so an expired or spent token resolves to nothing and never reaches the
   * update below.
   */
  const companyId = await resolveCompany("verification", tokenHash);
  if (!companyId) return { ok: false, reason: "not_found" };

  return withCompany(companyId, async (db, scoped) => {
    /*
     * Single-use enforced by the database, not by a read-then-write.
     *
     * updateManyAndReturn compiles to UPDATE ... WHERE ... RETURNING, so two
     * concurrent clicks on the same link contend on the row and exactly one
     * comes back with a row. Checking `consumedAt === null` first and updating
     * after would let both through.
     */
    const consumed = await db.emailVerificationToken.updateManyAndReturn({
      where: {
        tokenHash,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });

    const token = consumed[0];
    if (!token) return { ok: false, reason: "not_found" } as const;

    await db.user.update({
      where: { id: token.userId },
      data: { emailVerifiedAt: new Date() },
    });

    await auditWithin(db, scoped, {
      action: AuditAction.EMAIL_VERIFIED,
      userId: token.userId,
    });

    return { ok: true, companyId: scoped, userId: token.userId } as const;
  });
}

/**
 * Issue a fresh link for a signed-in user.
 *
 * Old tokens are consumed rather than deleted, so a link that is already in an
 * inbox stops working the moment a new one is requested. Leaving them live
 * would mean every resend widens the window rather than moving it.
 */
export async function reissueVerificationToken(
  companyId: string,
  userId: string,
): Promise<string> {
  const verification = issueVerificationToken();

  await withCompany(companyId, async (db, scoped) => {
    await db.emailVerificationToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await db.emailVerificationToken.create({
      data: {
        companyId: scoped,
        userId,
        tokenHash: verification.tokenHash,
        expiresAt: verification.expiresAt,
      },
    });
  });

  return verification.token;
}
