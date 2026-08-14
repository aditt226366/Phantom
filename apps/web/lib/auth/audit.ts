import "server-only";
import { AuditAction, withCompany, type CompanyClient } from "@whatsapp-os/db";
import type { Prisma } from "@whatsapp-os/db";

/**
 * Security-relevant events, per company.
 *
 * ---------------------------------------------------------------------------
 * What cannot be recorded here, and why
 * ---------------------------------------------------------------------------
 *
 * audit_log is company-scoped with company_id NOT NULL. A failed sign-in for a
 * username that does not exist has no company to attach it to, so it is
 * recorded only in login_attempts.
 *
 * That asymmetry is deliberate and must not be "fixed" by making company_id
 * nullable: that would break rule 1 in CLAUDE.md, and a nullable tenant key on
 * a table with an RLS policy is a row nobody can see and nobody can delete.
 */

export { AuditAction };

export interface AuditEntry {
  action: AuditAction;
  userId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
}

/** Write inside a transaction the caller already opened. */
export async function auditWithin(
  db: CompanyClient,
  companyId: string,
  entry: AuditEntry,
): Promise<void> {
  await db.auditLog.create({
    data: {
      companyId,
      action: entry.action,
      ...(entry.userId ? { userId: entry.userId } : {}),
      ...(entry.ip ? { ip: entry.ip } : {}),
      ...(entry.userAgent ? { userAgent: entry.userAgent.slice(0, 512) } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    },
  });
}

/**
 * Write in its own transaction.
 *
 * Never throws. An audit write that fails must not take down the operation it
 * is describing — a user being unable to log out because the log is full is a
 * worse outcome than a missing row, and the row is not the security control.
 */
export async function audit(
  companyId: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await withCompany(companyId, (db, scoped) =>
      auditWithin(db, scoped, entry),
    );
  } catch (error) {
    console.error(`Failed to write audit row ${entry.action}:`, error);
  }
}
