import "server-only";
import {
  INTEGRATION_LABELS,
  integrationFields,
  priceUsage,
  startOfPlatformDay,
  startOfPlatformMonth,
  type CompanyFilter,
  type IntegrationProviderName,
  type UsageKind,
} from "@whatsapp-os/core";
import type { Plan, Prisma } from "@whatsapp-os/db";
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
  /** Non-null when the company is suspended, so the caller can refuse. */
  companyDeactivatedAt: Date | null;
} | null> {
  const user = await adminPrisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: {
      id: true,
      companyId: true,
      email: true,
      company: { select: { deactivatedAt: true } },
    },
  });

  if (!user) return null;

  return {
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    companyDeactivatedAt: user.company.deactivatedAt,
  };
}

/**
 * Exactly what a company card renders, and nothing else.
 *
 * Six fields, each of which appears in the markup. The owner's email and
 * phone are not here, and neither is a user count, because the card does not
 * show them — and a field that is fetched but not displayed is one that has
 * crossed the tenant boundary for no reason anybody can point at.
 *
 * `slug` went for the same reason. Search still matches against it; matching
 * on a column does not require returning it.
 */
export interface CompanySummary {
  id: string;
  name: string;
  /** The OWNER-role user. Null for a company whose owner has been deleted. */
  ownerUsername: string | null;
  plan: Plan;
  status: "ACTIVE" | "DEACTIVATED";
  /**
   * The owner's last sign-in, not the company's most recent across all users.
   *
   * Named for what it is: paired with the owner's username on the card, an
   * unqualified "last login" invites the reader to assume the other meaning,
   * and the two diverge as soon as a company has staff.
   */
  ownerLastLoginAt: Date | null;
}

export interface CompanyPage {
  companies: CompanySummary[];
  /** Pass back as `cursor` for the next page. Null when this is the last. */
  nextCursor: string | null;
  /** True when a search or status filter narrowed the result. */
  filtered: boolean;
}

/**
 * Companies, filtered and paged in the database.
 *
 * Never "fetch all and filter in the browser": this is every tenant on the
 * installation, so that would ship the entire customer list to the client and
 * stop working at exactly the scale where it matters.
 *
 * ---------------------------------------------------------------------------
 * A note for whoever adds trigram indexing
 * ---------------------------------------------------------------------------
 *
 * `contains` compiles to ILIKE '%term%', and a leading wildcard cannot use a
 * btree index — Postgres has no way to seek into the middle of a string, so
 * this is a sequential scan over companies with a per-row match against three
 * columns.
 *
 * That is fine and will stay fine for a long time: the row count here is the
 * number of paying customers, and a seq scan over a few thousand of those is
 * faster than the planning it would take to avoid. When it stops being fine
 * the fix is pg_trgm with a GIN index on name and slug, not a schema change
 * and not client-side filtering. Written down so the next person inherits the
 * reasoning rather than the surprise.
 */
export async function listCompanies(
  filter: CompanyFilter = { status: "all", limit: 25 },
): Promise<CompanyPage> {
  const search = filter.q?.trim() ?? "";
  const filtered = search !== "" || filter.status !== "all";

  /*
   * Deliberately not annotated Prisma.CompanyWhereInput. no-raw-prisma.test.ts
   * allows exactly one Prisma type in this file, and satisfying that honestly
   * costs an `as const` — weakening the check to permit "only internal" uses
   * would make it a rule about where the type appears rather than whether it
   * does, and that is the version nobody can apply confidently.
   */
  const where = {
    ...(filter.status === "active" ? { deactivatedAt: null } : {}),
    ...(filter.status === "deactivated"
      ? { deactivatedAt: { not: null } }
      : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { slug: { contains: search, mode: "insensitive" as const } },
            {
              users: {
                some: {
                  username: { contains: search, mode: "insensitive" as const },
                },
              },
            },
          ],
        }
      : {}),
  };

  /* One more than asked for, so "is there a next page" needs no count query. */
  const rows = await adminPrisma.company.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      plan: true,
      deactivatedAt: true,
      users: {
        where: { role: "OWNER" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { username: true, lastLoginAt: true },
      },
    },
  });

  const page = rows.slice(0, filter.limit);

  return {
    companies: page.map((company) => ({
      id: company.id,
      name: company.name,
      ownerUsername: company.users[0]?.username ?? null,
      plan: company.plan,
      status: company.deactivatedAt === null ? "ACTIVE" : "DEACTIVATED",
      ownerLastLoginAt: company.users[0]?.lastLoginAt ?? null,
    })),
    nextCursor: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null,
    filtered,
  };
}

/**
 * One company, for its workspace.
 *
 * Wider than CompanySummary because the detail page renders more — and every
 * field here is rendered. `deactivatedAt` is the instant, not a repeat of
 * `status`: the overview says when it happened, which is the first thing an
 * operator asks when they find a company suspended.
 */
export interface CompanyDetail {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  status: "ACTIVE" | "DEACTIVATED";
  deactivatedAt: Date | null;
  ownerUsername: string | null;
  ownerLastLoginAt: Date | null;
  userCount: number;
  createdAt: Date;
}

/** Null for an id that does not exist — the caller renders a 404. */
export async function getCompanyDetail(
  companyId: string,
): Promise<CompanyDetail | null> {
  const company = await adminPrisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      deactivatedAt: true,
      createdAt: true,
      _count: { select: { users: true } },
      users: {
        where: { role: "OWNER" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { username: true, lastLoginAt: true },
      },
    },
  });

  if (!company) return null;

  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    plan: company.plan,
    status: company.deactivatedAt === null ? "ACTIVE" : "DEACTIVATED",
    deactivatedAt: company.deactivatedAt,
    ownerUsername: company.users[0]?.username ?? null,
    ownerLastLoginAt: company.users[0]?.lastLoginAt ?? null,
    userCount: company._count.users,
    createdAt: company.createdAt,
  };
}

/**
 * Suspend or restore a workspace.
 *
 * One function for both directions, because they are the same write and
 * pretending otherwise invites the reactivation path to drift — which is how
 * an operator ends up with a company that can be suspended and not restored.
 *
 * Returns false when the company is already in the requested state, so the
 * caller can avoid an audit row claiming something happened that did not.
 */
export async function setCompanyDeactivated(
  companyId: string,
  deactivated: boolean,
): Promise<boolean> {
  const { count } = await adminPrisma.company.updateMany({
    where: {
      id: companyId,
      ...(deactivated ? { deactivatedAt: null } : { deactivatedAt: { not: null } }),
    },
    data: { deactivatedAt: deactivated ? new Date() : null },
  });

  return count > 0;
}

/* ------------------------------------------------------------------ */
/* Platform overview                                                   */
/* ------------------------------------------------------------------ */

export interface SpendByCurrency {
  currency: string;
  micros: bigint;
}

export interface PlatformOverview {
  totalCompanies: number;
  activeCompanies: number;
  deactivatedCompanies: number;
  totalUsers: number;
  /** Since midnight in PLATFORM_TIMEZONE, not the server's zone. */
  apiCallsToday: number;
  /**
   * One entry per currency, never a single total.
   *
   * Meta bills in the ad account's currency and the AI providers bill USD, so
   * adding these together produces a number with no unit. If that is ever
   * wanted it is a conversion with a rate and a date, not a SUM.
   */
  spendThisMonth: SpendByCurrency[];
  /**
   * Events this month that no price entry matched.
   *
   * Surfaced beside the figure because a null cost is excluded from the SUM —
   * so the total is honest but incomplete, and only this number says by how
   * much.
   */
  unpricedThisMonth: number;
  planDistribution: Array<{ plan: Plan; count: number }>;
}

/**
 * Everything the overview shows, in four queries.
 *
 * Live, all of it. A dashboard with a plausible constant in it is worse than
 * one with an empty state, because nobody discovers the constant until they
 * act on it.
 */
export async function getPlatformOverview(
  now: Date = new Date(),
): Promise<PlatformOverview> {
  const dayStart = startOfPlatformDay(now);
  const monthStart = startOfPlatformMonth(now);

  const [companies, users, callsToday, spend, plans] = await Promise.all([
    adminPrisma.company.groupBy({
      by: ["deactivatedAt"],
      _count: { _all: true },
    }),
    adminPrisma.user.count(),
    adminPrisma.usageEvent.count({ where: { occurredAt: { gte: dayStart } } }),
    adminPrisma.usageEvent.groupBy({
      by: ["currency"],
      where: { occurredAt: { gte: monthStart } },
      _sum: { costMicros: true },
      _count: { _all: true },
    }),
    adminPrisma.company.groupBy({ by: ["plan"], _count: { _all: true } }),
  ]);

  const active = companies
    .filter((row) => row.deactivatedAt === null)
    .reduce((total, row) => total + row._count._all, 0);
  const deactivated = companies
    .filter((row) => row.deactivatedAt !== null)
    .reduce((total, row) => total + row._count._all, 0);

  /* currency is null exactly when the event was unpriced. */
  const unpriced = spend
    .filter((row) => row.currency === null)
    .reduce((total, row) => total + row._count._all, 0);

  return {
    totalCompanies: active + deactivated,
    activeCompanies: active,
    deactivatedCompanies: deactivated,
    totalUsers: users,
    apiCallsToday: callsToday,
    spendThisMonth: spend
      .filter((row): row is typeof row & { currency: string } =>
        Boolean(row.currency),
      )
      .map((row) => ({
        currency: row.currency,
        micros: row._sum.costMicros ?? 0n,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    unpricedThisMonth: unpriced,
    planDistribution: plans
      .map((row) => ({ plan: row.plan, count: row._count._all }))
      .sort((a, b) => a.plan.localeCompare(b.plan)),
  };
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

export interface SealedSecretRow {
  key: string;
  ciphertext: string;
}

/**
 * Ciphertexts for one integration, for the provider-call path only.
 *
 * The one query in this file that returns a ciphertext, and it exists so that
 * decryption can happen *outside* a transaction: this closes, then the caller
 * opens the values and makes the network call. Nothing here decrypts.
 */
export async function loadSealedSecrets(
  companyId: string,
  provider: IntegrationProviderName,
): Promise<{ integrationId: string; secrets: SealedSecretRow[] } | null> {
  const integration = await adminPrisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
    select: {
      id: true,
      secrets: { select: { key: true, ciphertext: true } },
    },
  });

  if (!integration) return null;

  return {
    integrationId: integration.id,
    secrets: integration.secrets.map((row) => ({
      key: row.key,
      ciphertext: row.ciphertext,
    })),
  };
}

export interface VerificationRecord {
  ok: boolean;
  statusCode?: number | undefined;
  /** Already scrubbed by the adapter. */
  error?: string | undefined;
  failureKind?: string | undefined;
  details?: Prisma.InputJsonValue | undefined;
  /** False for a transient failure, which must not move the badge. */
  demote: boolean;
}

/**
 * Write what a provider said, and move the badge only if it should move.
 *
 * A transient failure updates last_error and appends to the log while leaving
 * `status` exactly as it was — so a Meta outage does not tell every operator
 * their credentials are broken, and their credentials do not get re-entered
 * in response.
 */
export async function recordVerification(
  companyId: string,
  integrationId: string,
  result: VerificationRecord,
): Promise<void> {
  await adminPrisma.$transaction(async (tx) => {
    await tx.integrationVerification.create({
      data: {
        companyId,
        integrationId,
        ok: result.ok,
        ...(result.statusCode === undefined
          ? {}
          : { statusCode: result.statusCode }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.failureKind === undefined
          ? {}
          : { failureKind: result.failureKind }),
        ...(result.details === undefined ? {} : { details: result.details }),
      },
    });

    await tx.integration.update({
      where: { id: integrationId },
      data: {
        lastError: result.ok ? null : (result.error ?? null),
        ...(result.ok
          ? { status: "CONNECTED", lastVerifiedAt: new Date() }
          : result.demote
            ? { status: "NOT_CONNECTED" }
            : {}),
      },
    });
  });
}

/**
 * Record usage for a company the admin panel is acting on.
 *
 * The pricing decision is priceUsage() in core, shared with the tenant-side
 * emitter — only the client differs. Duplicating the price lookup here is how
 * two paths end up charging different amounts for the same event.
 */
export async function recordAdminUsage(
  companyId: string,
  kind: UsageKind,
  dedupeKey: string,
): Promise<void> {
  const priced = priceUsage(kind, 1);

  await adminPrisma.usageEvent.createMany({
    data: [{ companyId, kind, quantity: 1, dedupeKey, ...priced }],
    skipDuplicates: true,
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
