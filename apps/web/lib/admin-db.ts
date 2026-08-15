import "server-only";
import {
  INTEGRATION_LABELS,
  integrationFields,
  type IntegrationProviderName,
} from "@whatsapp-os/core";
import type { Prisma } from "@whatsapp-os/db";
import { adminPrisma } from "@whatsapp-os/db/admin";
import { seal } from "@/lib/integrations/seal";

/**
 * The only module in the repository permitted to import the admin client.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 *
 * app_admin can read across every company. That capability has to live
 * somewhere, and the choice is between spreading it thinly — a `adminPrisma`
 * import wherever it happens to be convenient — or concentrating it behind a
 * short list of named queries that can be read in one sitting.
 *
 * So: no export of the client, ever. Every function here returns a specific,
 * bounded shape. A caller that wants something else has to add a function here,
 * which is a diff in a file whose whole purpose is to be reviewed.
 *
 * A no-restricted-imports rule bans "@whatsapp-os/db/admin" everywhere else.
 *
 * ---------------------------------------------------------------------------
 * Admin authentication also lives here
 * ---------------------------------------------------------------------------
 *
 * app_runtime holds no grants at all on admin_users, admin_sessions or
 * admin_audit_log — explicitly revoked, and asserted by a schema invariant — so
 * the admin session lookup physically cannot go through the tenant client.
 * These are narrow lookups by unique key, not general access.
 */

export interface AdminAuditEntry {
  adminUserId?: string | undefined;
  action: string;
  ip?: string | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
}

/**
 * Record what an admin did — including what they merely looked at.
 *
 * Reads are audited as well as writes. The panel can see every company's data,
 * so "which tenants did this operator open" is exactly the question an incident
 * review needs answered, and it is unanswerable after the fact if only
 * mutations were recorded.
 */
export async function writeAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    await adminPrisma.adminAuditLog.create({
      data: {
        action: entry.action,
        ...(entry.adminUserId ? { adminUserId: entry.adminUserId } : {}),
        ...(entry.ip ? { ip: entry.ip } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      },
    });
  } catch (error) {
    /* An audit failure must not take down the operation it describes. */
    console.error(`Failed to write admin audit row ${entry.action}:`, error);
  }
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export async function findAdminByUsername(username: string) {
  return adminPrisma.adminUser.findUnique({
    where: { username },
    select: { id: true, username: true, passwordHash: true },
  });
}

export async function upsertAdminUser(
  username: string,
  passwordHash: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await adminPrisma.adminUser.findUnique({
    where: { username },
    select: { id: true },
  });

  if (existing) {
    await adminPrisma.adminUser.update({
      where: { id: existing.id },
      data: { passwordHash },
    });
    return { id: existing.id, created: false };
  }

  const created = await adminPrisma.adminUser.create({
    data: { username, passwordHash },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export async function createAdminSessionRow(input: {
  adminUserId: string;
  tokenHash: string;
  csrfSecret: string;
  expiresAt: Date;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}): Promise<void> {
  await adminPrisma.adminSession.create({
    data: {
      adminUserId: input.adminUserId,
      tokenHash: input.tokenHash,
      csrfSecret: input.csrfSecret,
      expiresAt: input.expiresAt,
      ...(input.ipHash ? { ipHash: input.ipHash } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 512) } : {}),
    },
  });
}

export async function findAdminSessionByTokenHash(tokenHash: string) {
  return adminPrisma.adminSession.findUnique({
    where: { tokenHash },
    include: { adminUser: { select: { id: true, username: true } } },
  });
}

export async function revokeAdminSessionByTokenHash(
  tokenHash: string,
): Promise<void> {
  await adminPrisma.adminSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function touchAdminSession(
  id: string,
  expiresAt: Date,
): Promise<void> {
  await adminPrisma.adminSession.update({
    where: { id },
    data: { lastSeenAt: new Date(), expiresAt },
  });
}

export async function recordAdminLogin(id: string): Promise<void> {
  await adminPrisma.adminUser.update({
    where: { id },
    data: { lastLoginAt: new Date() },
  });
}

/* ------------------------------------------------------------------ */
/* Cross-tenant reads                                                  */
/* ------------------------------------------------------------------ */

/**
 * Look up a user for an admin-issued reset.
 *
 * Returns the identifiers needed to issue a link and mail it, and nothing that
 * would let the panel act as the user. No password hash, no session data.
 */
export async function findUserForReset(username: string): Promise<{
  id: string;
  companyId: string;
  email: string;
} | null> {
  return adminPrisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: { id: true, companyId: true, email: true },
  });
}

export interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  userCount: number;
  createdAt: Date;
}

/**
 * Every company on the installation.
 *
 * The one cross-tenant read in this commit, and deliberately a summary: no
 * message content, no contact data, nothing that would make the admin panel a
 * convenient way to read a customer's inbox. Widening it is a change to this
 * function, in this file.
 */
export async function listCompanies(): Promise<CompanySummary[]> {
  const companies = await adminPrisma.company.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });

  return companies.map((company) => ({
    id: company.id,
    name: company.name,
    slug: company.slug,
    createdAt: company.createdAt,
    userCount: company._count.users,
  }));
}

/* ------------------------------------------------------------------ */
/* Integrations and usage                                              */
/* ------------------------------------------------------------------ */

/**
 * What the console may know about a stored credential.
 *
 * There is no shape in this file that carries a ciphertext, let alone a
 * plaintext. last4 is the entire disclosure, and it is null for values short
 * enough that four characters would give most of them away.
 */
export interface StoredSecretView {
  key: string;
  last4: string | null;
  keyId: string;
  updatedAt: Date;
}

export interface IntegrationView {
  id: string;
  provider: IntegrationProviderName;
  label: string;
  status: "CONNECTED" | "NOT_CONNECTED";
  lastVerifiedAt: Date | null;
  lastError: string | null;
  secrets: StoredSecretView[];
}

/** Every integration a company has, masked. */
export async function listIntegrations(
  companyId: string,
): Promise<IntegrationView[]> {
  const rows = await adminPrisma.integration.findMany({
    where: { companyId },
    orderBy: { provider: "asc" },
    select: {
      id: true,
      provider: true,
      label: true,
      status: true,
      lastVerifiedAt: true,
      lastError: true,
      secrets: {
        /* Note what is absent: ciphertext. */
        select: { key: true, last4: true, keyId: true, updatedAt: true },
        orderBy: { key: "asc" },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    secrets: row.secrets.map((secret) => ({
      key: secret.key,
      last4: secret.last4,
      keyId: secret.keyId,
      updatedAt: secret.updatedAt,
    })),
  }));
}

export interface SaveSecretsResult {
  integrationId: string;
  /** Keys whose stored value was replaced. */
  saved: string[];
  /** Keys left alone because the field was submitted blank. */
  unchanged: string[];
}

/**
 * Store credentials for one provider. Write-only.
 *
 * ---------------------------------------------------------------------------
 * Why the encryption happens in here
 * ---------------------------------------------------------------------------
 *
 * The AAD is ${companyId}:${integrationId}:${key}, so a value cannot be sealed
 * until the integration row exists and has an id. On a first save that row is
 * being created by this call. Doing the obvious thing — encrypt the submitted
 * values, then insert them — builds an AAD from an id that does not exist yet,
 * and produces rows that decrypt under nothing.
 *
 * So: create the integration, then seal against its id, then write the
 * secrets, all in one transaction. Safe to hold, because sealing is CPU only —
 * no provider call happens anywhere near here.
 *
 * ---------------------------------------------------------------------------
 * Blank means unchanged
 * ---------------------------------------------------------------------------
 *
 * A blank field leaves the stored value alone, so an operator can rotate one
 * credential without re-typing the other three — which they cannot do anyway,
 * since the panel never shows them. Clearing a credential is Disconnect, which
 * is a different button and says what it does.
 */
export async function saveIntegrationSecrets(
  companyId: string,
  provider: IntegrationProviderName,
  submitted: Readonly<Record<string, string>>,
): Promise<SaveSecretsResult> {
  const fields = integrationFields(provider);

  return adminPrisma.$transaction(async (tx) => {
    /* First, because the id below is part of what authenticates every value. */
    const integration = await tx.integration.upsert({
      where: { companyId_provider: { companyId, provider } },
      create: { companyId, provider, label: INTEGRATION_LABELS[provider] },
      update: {},
      select: { id: true },
    });

    const saved: string[] = [];
    const unchanged: string[] = [];

    for (const field of fields) {
      const value = submitted[field.key]?.trim() ?? "";

      if (value === "") {
        unchanged.push(field.key);
        continue;
      }

      const sealed = seal(companyId, integration.id, field.key, value);

      await tx.integrationSecret.upsert({
        where: {
          integrationId_key: { integrationId: integration.id, key: field.key },
        },
        create: {
          companyId,
          integrationId: integration.id,
          key: field.key,
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          last4: sealed.last4,
        },
        update: {
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          last4: sealed.last4,
        },
      });

      saved.push(field.key);
    }

    return { integrationId: integration.id, saved, unchanged };
  });
}

/**
 * Remove an integration and everything under it.
 *
 * The explicit way to clear a credential. Secrets and verification history go
 * with it by cascade — there is no value in keeping ciphertext nothing can
 * describe.
 */
export async function disconnectIntegration(
  companyId: string,
  provider: IntegrationProviderName,
): Promise<boolean> {
  const { count } = await adminPrisma.integration.deleteMany({
    where: { companyId, provider },
  });

  return count > 0;
}
