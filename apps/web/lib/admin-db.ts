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
    /*
     * Then id, and here a tie does more than reorder a page.
     *
     * This is keyset pagination: the next page starts AFTER the cursor row in
     * this ordering. If the ordering does not place the cursor row uniquely -
     * and created_at does not, since a seeded or imported batch of companies
     * shares one - then rows tied with it can fall on either side of the
     * boundary, so a company is skipped entirely or shown on two pages. An
     * operator paging a company list would simply never see it.
     */
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      plan: true,
      deactivatedAt: true,
      users: {
        where: { role: "OWNER" },
        /* Then id: `take: 1` over a tie picks an arbitrary owner, and this is
           the name the admin list shows for the company. */
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  /** Milliseconds between two sends of one broadcast. Pacing, not the limit. */
  broadcastGapMs: number;
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
      broadcastGapMs: true,
      _count: { select: { users: true } },
      users: {
        where: { role: "OWNER" },
        /* Then id: `take: 1` over a tie picks an arbitrary owner, and this is
           the name the admin list shows for the company. */
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
    broadcastGapMs: company.broadcastGapMs,
  };
}

/**
 * Change how fast this tenant's broadcasts send.
 *
 * Pacing, and NOT the limit - the messaging tier caps unique recipients per
 * rolling 24 hours and no gap gets past it. What this changes is how hard a
 * number is pushed within that, which is a judgement about a tenant's quality
 * rating and therefore an operator's call rather than a tenant's.
 *
 * Bounded here as well as by a CHECK constraint. Zero would make a broadcast
 * one burst - the behaviour the gap exists to prevent - and the constraint is
 * the backstop that does not depend on this having validated. An hour is the
 * upper end: past that a broadcast is a schedule rather than a send.
 *
 * A running broadcast is NOT re-paced. It copied the gap at start, so this
 * takes effect on the next one - which is what stops an operator accidentally
 * changing the speed of something already half sent.
 */
export const MIN_BROADCAST_GAP_MS = 100;
export const MAX_BROADCAST_GAP_MS = 3_600_000;

export async function setCompanyBroadcastGap(
  companyId: string,
  gapMs: number,
): Promise<boolean> {
  if (!Number.isInteger(gapMs)) return false;
  if (gapMs < MIN_BROADCAST_GAP_MS || gapMs > MAX_BROADCAST_GAP_MS) return false;

  const { count } = await adminPrisma.company.updateMany({
    where: { id: companyId },
    data: { broadcastGapMs: gapMs },
  });

  return count === 1;
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
  /**
   * Webhook deliveries that reached us and could not be routed, last 7 days.
   *
   * P6: operator visibility is a commit rather than a claim. These rows have
   * existed since 4a and were readable only by querying the table, which means
   * a misconfigured tenant was invisible to the person whose job is noticing.
   *
   * The count is DISTINCT KEYS, not deliveries. The table aggregates per
   * webhook key - one row, an attemptCount, and a lastSeenAt - so a row is one
   * misconfiguration and its attempts are how loudly it is failing. An operator
   * acts on the first number; the second only says how urgent it is, and is
   * carried alongside rather than instead.
   *
   * Split by reason because they are different problems with different
   * remedies, and a single total would average them into neither:
   *
   *   unknownKey    the path matches no integration - a rotated key, a stale
   *                 Meta config, or somebody probing. Nobody's messages are
   *                 arriving, and the tenant may not know.
   *   badSignature  the key resolves but the signature did not verify. Almost
   *                 always a stale app secret on a REAL tenant, which is a
   *                 support call waiting to happen; occasionally a forgery.
   *
   * Windowed at 7 days rather than all-time. An all-time count only ever rises,
   * so it stops being a signal the first time anything goes wrong - what an
   * operator needs is "is this happening now".
   */
  unroutableThisWeek: {
    unknownKey: number;
    badSignature: number;
    /** Deliveries behind those keys. How loud, rather than how many. */
    attempts: number;
  };
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

  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  /* Every groupBy here is order-independent: each is reduced to a number or a
     lookup below, and none is rendered in sequence. */
  const [companies, users, callsToday, spend, plans, unroutable] =
    await Promise.all([
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
    /* Grouped rather than two counts: one round trip, and the reasons cannot
       drift apart by being windowed differently. */
    /* Grouped rather than several counts: one round trip, and the reasons
       cannot drift apart by being windowed differently. Windowed on lastSeenAt
       because that is "is this still happening", which is the question - a key
       that failed all last month and stopped is not today's problem. */
    adminPrisma.unroutableWebhook.groupBy({
      by: ["reason"],
      where: { lastSeenAt: { gte: weekStart } },
      _count: { _all: true },
      _sum: { attemptCount: true },
    }),
  ]);

  const unroutableFor = (reason: string): number =>
    unroutable.find((row) => row.reason === reason)?._count?._all ?? 0;

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
    unroutableThisWeek: {
      unknownKey: unroutableFor("UNKNOWN_KEY"),
      badSignature: unroutableFor("BAD_SIGNATURE"),
      attempts: unroutable.reduce(
        (total, row) => total + (row._sum?.attemptCount ?? 0),
        0,
      ),
    },
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
  /**
   * When the provider says this credential stops working, where we know.
   *
   * Null is two different things and the console must not conflate them: a
   * credential that never expires, and one whose expiry we did not manage to
   * ask for. Both render as "no expiry recorded" and neither demotes - see
   * tokenExpiryState, which has no_expiry as its own member for this reason.
   */
  expiresAt: Date | null;
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
        select: {
          key: true,
          last4: true,
          keyId: true,
          updatedAt: true,
          expiresAt: true,
        },
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
      expiresAt: secret.expiresAt,
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
  /**
   * Expiry per key, for the credentials whose expiry this system tracks.
   *
   * Passed in rather than looked up here, because finding it out is a call to
   * Meta and this function runs inside a transaction. The conventions are
   * explicit that a transaction holds a pooled connection with a five-second
   * budget; a Graph call inside one is a ten-second provider timeout sitting on
   * it. The caller asks first and hands the answer down.
   *
   * A key absent from this map leaves the stored expiry ALONE, exactly as a
   * blank field leaves the stored value alone. Writing null for an absent key
   * would erase a known expiry every time an operator saved a different
   * credential on the same form.
   */
  expiries: Readonly<Record<string, Date | null>> = {},
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
          ...(field.key in expiries ? { expiresAt: expiries[field.key] } : {}),
        },
        update: {
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          last4: sealed.last4,
          /* A NEW value means the old expiry describes a credential that is no
             longer there. Where the caller could not learn the new one, null is
             the honest record - "we do not know when this lapses" - and is
             strictly better than keeping a date that belonged to a token this
             row no longer holds. */
          ...(field.key in expiries ? { expiresAt: expiries[field.key] } : {}),
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
 * Delete the stored credentials, keep the record that they existed.
 *
 * The secrets are actually removed. A disconnect that only flipped the badge
 * would leave every ciphertext in place, and "disconnected" would describe a
 * label rather than a state — the vault would still hold a live token for a
 * provider the panel claims is not connected.
 *
 * The Integration row and its verification history stay. An operator asking
 * "was this ever working, and what did it say when it stopped" is asking a
 * reasonable question, and the history is the only thing that answers it. It
 * holds no secret: every stored error was scrubbed before it was written.
 *
 * Unrecoverable by design — re-connecting means re-entering every value, since
 * nothing here can read them back. Hence the confirmation step.
 */
export async function disconnectIntegration(
  companyId: string,
  provider: IntegrationProviderName,
): Promise<{ secretsRemoved: number } | null> {
  const integration = await adminPrisma.integration.findUnique({
    where: { companyId_provider: { companyId, provider } },
    select: { id: true },
  });

  if (!integration) return null;

  return adminPrisma.$transaction(async (tx) => {
    const { count } = await tx.integrationSecret.deleteMany({
      where: { companyId, integrationId: integration.id },
    });

    await tx.integration.update({
      where: { id: integration.id },
      data: {
        status: "NOT_CONNECTED",
        lastVerifiedAt: null,
        lastError: null,
      },
    });

    return { secretsRemoved: count };
  });
}

export interface SealedSecretRow2 {
  companyId: string;
  integrationId: string;
  key: string;
  keyId: string;
  ciphertext: string;
}

/**
 * Every stored credential on the installation, sealed.
 *
 * The widest read in this file, and it exists for exactly two callers: the
 * rotation status check and the rotation itself. Both are operator tools that
 * have to reason about ciphertext they cannot avoid touching — a status check
 * that cannot open a row is the whole point of a status check.
 *
 * Returns the sealed value, never a plaintext. What the caller does with it is
 * the caller's business, and both of them only ever assert that decrypt
 * succeeded.
 */
export async function listAllSealedSecrets(): Promise<SealedSecretRow2[]> {
  /* (companyId, key) is not unique across integrations, and that is fine here:
     rotation re-seals every row it is given, so the order is not observable.
     Ordered at all only to make a long run's log readable. */
  const rows = await adminPrisma.integrationSecret.findMany({
    orderBy: [{ companyId: "asc" }, { key: "asc" }],
    select: {
      companyId: true,
      integrationId: true,
      key: true,
      keyId: true,
      ciphertext: true,
    },
  });

  return rows;
}

/** Companies holding at least one credential, for the rotation fan-out. */
export async function listCompanyIdsWithSecrets(): Promise<
  Array<{ companyId: string; secrets: number }>
> {
  const rows = await adminPrisma.integrationSecret.groupBy({
    by: ["companyId"],
    _count: { _all: true },
  });

  return rows
    .map((row) => ({ companyId: row.companyId, secrets: row._count._all }))
    .sort((a, b) => a.companyId.localeCompare(b.companyId));
}

/**
 * Every company, for the dashboard rollup fan-out.
 *
 * Every one, with no filter, which is unlike the two lists around it - and the
 * difference is the point. A company with no integrations has nothing to verify
 * and no secrets to reseal, but it does have a dashboard, and that dashboard is
 * the first screen it sees. Filtering here would leave exactly the new tenants
 * this backfill matters most to without a rollup row.
 *
 * Deactivated companies included, for the reason lib/dashboard/scheduler.ts
 * gives: the operator cannot sign in, but the platform admin still reads the
 * workspace, and a suspension that silently froze the numbers would leave the
 * panel showing figures from the day of the suspension with nothing to say so.
 */
export async function listAllCompanyIds(): Promise<string[]> {
  /* Unordered and order-independent: every id is processed by the backfill, so
     the sequence is not observable anywhere. */
  const rows = await adminPrisma.company.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  return rows.map((row) => row.id);
}

/** Companies with at least one integration, for the repair fan-out. */
export async function listCompanyIdsWithIntegrations(): Promise<string[]> {
  const rows = await adminPrisma.integration.findMany({
    distinct: ["companyId"],
    select: { companyId: true },
    orderBy: { companyId: "asc" },
  });

  return rows.map((row) => row.companyId);
}

export interface RepairRun {
  id: string;
  startedAt: Date;
  totalCompanies: number;
  /** Derived, not counted — see the schema comment. */
  completedCompanies: number;
}

export async function startRepairRun(
  adminUserId: string,
  totalCompanies: number,
): Promise<string> {
  const run = await adminPrisma.adminRepairRun.create({
    data: { adminUserId, totalCompanies },
    select: { id: true },
  });

  return run.id;
}

/**
 * The most recent run and how far it has got.
 *
 * Progress is the number of distinct companies with a verification newer than
 * the run started, rather than a counter the worker increments — app_runtime
 * holds no grants on the admin tables, so it could not increment one, and a
 * derived figure cannot drift from what actually happened.
 */
export async function latestRepairRun(): Promise<RepairRun | null> {
  const run = await adminPrisma.adminRepairRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, totalCompanies: true },
  });

  if (!run) return null;

  const done = await adminPrisma.integrationVerification.findMany({
    where: { createdAt: { gte: run.startedAt } },
    distinct: ["companyId"],
    select: { companyId: true },
  });

  return {
    id: run.id,
    startedAt: run.startedAt,
    totalCompanies: run.totalCompanies,
    completedCompanies: done.length,
  };
}

export interface VerificationEntry {
  id: string;
  provider: IntegrationProviderName;
  ok: boolean;
  statusCode: number | null;
  failureKind: string | null;
  /** Scrubbed by the adapter before it was ever stored. */
  error: string | null;
  /*
   * Opaque on purpose. Typing this Prisma.JsonValue would put a second Prisma
   * type in this file, and the narrowness check allows exactly one — the
   * consumer stringifies it for display and needs no more than this.
   */
  details: unknown;
  createdAt: Date;
}

export interface VerificationPage {
  entries: VerificationEntry[];
  nextCursor: string | null;
}

/**
 * Verification history for a company.
 *
 * Bounded: this table gets one row per check per integration and nothing ever
 * prunes it, so an unpaged read would grow without limit against the busiest
 * table in the workspace.
 */
export async function listVerifications(
  companyId: string,
  options: { cursor?: string | undefined; limit?: number } = {},
): Promise<VerificationPage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  const rows = await adminPrisma.integrationVerification.findMany({
    where: { companyId },
    /*
     * Then id - the same keyset-pagination hazard as listCompanies, and more
     * reachable here. These rows are written by a check that runs against every
     * integration in one pass, so a whole page of them can share a created_at
     * and the page boundary lands inside the tie almost by construction.
     */
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      ok: true,
      statusCode: true,
      failureKind: true,
      error: true,
      details: true,
      createdAt: true,
      integration: { select: { provider: true } },
    },
  });

  const page = rows.slice(0, limit);

  return {
    entries: page.map((row) => ({
      id: row.id,
      provider: row.integration.provider,
      ok: row.ok,
      statusCode: row.statusCode,
      failureKind: row.failureKind,
      error: row.error,
      details: row.details,
      createdAt: row.createdAt,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/* ------------------------------------------------------------------ */
/* KYC documents                                                       */
/* ------------------------------------------------------------------ */

/**
 * One upload, as the panel sees it. Never the bytes.
 *
 * Mirrors KycDocumentStat from packages/db and is written out again rather
 * than imported, because that one is produced under withCompany and this one
 * under the cross-company client. Two shapes that happen to match is the
 * honest description: sharing the type would suggest they share a scope.
 */
export interface AdminKycDocument {
  id: string;
  companyId: string;
  kind: string;
  status: string;
  sha256: string;
  mimeType: string;
  originalFilename: string;
  byteSize: number;
  uploadedAt: Date;
  reviewedAt: Date | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

const ADMIN_KYC_COLUMNS = {
  id: true,
  companyId: true,
  kind: true,
  status: true,
  sha256: true,
  mimeType: true,
  originalFilename: true,
  byteSize: true,
  createdAt: true,
  reviewedAt: true,
  reviewNote: true,
  reviewedByAdmin: { select: { username: true } },
} as const;

interface AdminKycRow {
  id: string;
  companyId: string;
  kind: string;
  status: string;
  sha256: string;
  mimeType: string;
  originalFilename: string;
  byteSize: number;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
  reviewedByAdmin: { username: string } | null;
}

function toAdminKycDocument(row: AdminKycRow): AdminKycDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    status: row.status,
    sha256: row.sha256,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    byteSize: row.byteSize,
    uploadedAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    /* The operator's name, resolved here. The tenant never sees this column
       and no tenant-facing query selects it. */
    reviewedByUsername: row.reviewedByAdmin?.username ?? null,
    reviewNote: row.reviewNote,
  };
}

/** Every upload a company has ever made, newest first. */
export async function listCompanyKycDocuments(
  companyId: string,
): Promise<AdminKycDocument[]> {
  const rows = await adminPrisma.kycDocument.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: ADMIN_KYC_COLUMNS,
  });

  return rows.map((row) => toAdminKycDocument(row as AdminKycRow));
}

/** One upload by id, or null. Never the bytes. */
export async function getKycDocument(
  documentId: string,
): Promise<AdminKycDocument | null> {
  const row = await adminPrisma.kycDocument.findUnique({
    where: { id: documentId },
    select: ADMIN_KYC_COLUMNS,
  });

  return row ? toAdminKycDocument(row as AdminKycRow) : null;
}

/**
 * Record a decision on one document.
 *
 * Scalars only - a status word, a note, the operator's id - so this stays a
 * named query rather than a passthrough. The caller has already validated the
 * status against a closed list.
 *
 * updateMany rather than update, with the status guarded in the where clause:
 * two operators opening the same document and both clicking is an ordinary
 * race, and this makes the second one a no-op it can be told about rather than
 * a silent overwrite of the first verdict. Returns whether it landed.
 */
export async function decideKycDocument(input: {
  documentId: string;
  status: "APPROVED" | "REJECTED";
  reviewNote: string | null;
  adminUserId: string;
  /* The status the operator was looking at when they decided. */
  expectedStatus: string;
}): Promise<boolean> {
  const { count } = await adminPrisma.kycDocument.updateMany({
    where: { id: input.documentId, status: input.expectedStatus as never },
    data: {
      status: input.status,
      reviewNote: input.reviewNote,
      reviewedByAdminId: input.adminUserId,
      reviewedAt: new Date(),
    },
  });

  return count === 1;
}

/**
 * Permanently remove every document a company has filed.
 *
 * ---------------------------------------------------------------------------
 * This is a DPDP requirement, not a convenience
 * ---------------------------------------------------------------------------
 *
 * India's Digital Personal Data Protection Act gives a Data Principal the
 * right to erasure, and obliges a Data Fiduciary to delete personal data once
 * the purpose it was collected for is served. An Aadhaar card is about as
 * squarely inside that as personal data gets.
 *
 * So a hard delete exists from the start rather than being added when somebody
 * asks. The alternative is discovering, under a deadline, that the only way to
 * honour a request is a hand-written statement against production - which is
 * how the wrong company's documents get deleted.
 *
 * Hard, not soft. A deleted_at column would leave the bytes in the table, in
 * every base backup taken afterwards, and in the WAL - which does not satisfy
 * erasure and would be worse than useless: it would look like it did.
 *
 * Deliberately per company and never per document. Erasure is a request about
 * a person's data, not about one file, and a per-document version would invite
 * using it to tidy up a rejected upload - destroying the audit trail the
 * append-only table exists to keep.
 *
 * Returns the number of rows removed so the caller can report it. The bytes
 * are gone at that point; the audit row naming this operator is not.
 */
export async function deleteCompanyKycDocuments(
  companyId: string,
): Promise<number> {
  const { count } = await adminPrisma.kycDocument.deleteMany({
    where: { companyId },
  });

  return count;
}

/**
 * 512 KiB, for the arithmetic packages/db/src/media-store.ts sets out in full.
 */
const KYC_CHUNK_BYTES = 512 * 1024;

/**
 * The bytes of one document, as a stream.
 *
 * ---------------------------------------------------------------------------
 * Why this is here and not a call into packages/db
 * ---------------------------------------------------------------------------
 *
 * readKycDocument() reads under withCompany, which scopes to app_runtime and a
 * company context. The panel has neither: an admin session belongs to no
 * company, and reaching for a company id to open a tenant scope with would
 * make an admin-client lookup a FOURTH origin for a trusted company id, beside
 * the three CLAUDE.md names. That is a boundary change, and it is not one this
 * feature needs - app_admin already has an explicit policy on the table.
 *
 * So the same statement, over the cross-company client. The chunking is not
 * decoration: it is what keeps an operator opening a 5 MB scan from
 * materialising it inside the request, and substring() over a bytea is a
 * server-side slice only because the column is STORAGE EXTERNAL.
 *
 * Returns null when the id is unknown. The route answers 404 either way.
 */
export async function readKycDocumentBytes(
  documentId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const meta = await adminPrisma.kycDocument.findUnique({
    where: { id: documentId },
    select: { byteSize: true },
  });

  if (!meta) return null;

  const { byteSize } = meta;
  let offset = 0;

  /* Postgres substring is 1-based; offset is not. */
  const readChunk = async (at: number, length: number) => {
    const rows = await adminPrisma.$queryRaw<
      Array<{ chunk: Uint8Array | null }>
    >`SELECT substring(bytes from ${at + 1} for ${length}) AS chunk
        FROM kyc_documents WHERE id = ${documentId}`;

    return rows[0]?.chunk ?? null;
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (offset >= byteSize) {
          controller.close();
          return;
        }

        const chunk = await readChunk(
          offset,
          Math.min(KYC_CHUNK_BYTES, byteSize - offset),
        );

        /*
         * The row vanished mid-stream - an erasure request running while an
         * operator reads. The headers went out with the first chunk, so there
         * is no status left to change: erroring breaks the transfer visibly
         * rather than handing over a truncated PDF under a 200 that already
         * promised Content-Length bytes.
         */
        if (!chunk || chunk.byteLength === 0) {
          controller.error(
            new Error(
              `kyc document ${documentId} ended after ${offset} of ${byteSize} bytes`,
            ),
          );
          return;
        }

        offset += chunk.byteLength;
        controller.enqueue(chunk);
      },
    },
    /* Never read ahead: one read() is one chunk, and nothing is fetched for an
       operator who has closed the tab. */
    { highWaterMark: 0 },
  );
}

/* ------------------------------------------------------------------------- *
 * Stored webhook payloads, for the conversation-charge backfill
 * ------------------------------------------------------------------------- */

export interface StoredWebhookPayload {
  id: string;
  companyId: string;
  payload: string;
  payloadTruncated: boolean;
}

/**
 * One page of stored webhook deliveries, across every company.
 *
 * A named function rather than an exported client, per this file's own rule:
 * the backfill wants to read across tenants, which no request-scoped client can
 * do, and the answer to that is a bounded shape here rather than an
 * `adminPrisma` import in a script.
 *
 * Bounded in the two ways that matter. The columns are exactly what re-parsing
 * a payload needs - never the whole row, which carries a delivery key and
 * timestamps the caller has no use for - and the read is paged, because
 * whatsapp_webhook_events is the fastest-growing table in the system and a
 * production one will not fit in memory.
 *
 * Ordered by id, which is unique. `created_at` would tie across a burst of
 * deliveries, and a keyset page boundary inside a tie skips rows - which here
 * means silently missing charges, in a backfill whose whole purpose is that
 * the data is about to become unrecoverable. See the conventions on limited
 * reads.
 */
export async function listStoredWebhookPayloads(options: {
  after?: string | undefined;
  take: number;
}): Promise<StoredWebhookPayload[]> {
  return adminPrisma.whatsAppWebhookEvent.findMany({
    ...(options.after ? { cursor: { id: options.after }, skip: 1 } : {}),
    take: options.take,
    orderBy: { id: "asc" },
    select: {
      id: true,
      companyId: true,
      payload: true,
      payloadTruncated: true,
    },
  });
}
