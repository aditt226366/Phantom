import { prisma } from "./client.ts";

/**
 * Deliveries that arrived and could not be accepted.
 *
 * Uses the unscoped client, like resolve-company.ts and for the same kind of
 * reason: an unknown webhook key resolves to no company, so there is no scope
 * to open. The table is global and carries no RLS policy, which is why this
 * module is small and does exactly one thing.
 *
 * The IP hash is computed by the caller. Hashing lives in the web layer, where
 * ENCRYPTION_KEY is already read for session and admin-session addresses, and
 * dragging that into packages/db would give this package a second reason to
 * care about key material.
 */

export type UnroutableReasonName = "UNKNOWN_KEY" | "BAD_SIGNATURE";

export interface UnroutableWebhookInput {
  /** sha256 of the path segment. Never the segment itself. */
  webhookKeyHash: string;
  reason: UnroutableReasonName;
  /** Known only for BAD_SIGNATURE, where the key did resolve. */
  companyId?: string;
  ipHash?: string;
}

/**
 * Record one unacceptable delivery.
 *
 * Upsert with a counter rather than an insert per request. The endpoint is
 * unauthenticated, so every row here was written by whoever asked - a flood
 * against one URL must stay one row.
 *
 * That alone does not bound the table: rotating the key in the URL mints a
 * fresh hash each time, so a per-key counter cannot bound a per-key attack. The
 * bound is the per-address throttle in front of this, which is keyed on the
 * source and not on the webhook key. Both are needed; neither is sufficient.
 */
export async function recordUnroutableWebhook(
  input: UnroutableWebhookInput,
): Promise<void> {
  const now = new Date();

  await prisma.unroutableWebhook.upsert({
    where: { webhookKeyHash: input.webhookKeyHash },
    create: {
      webhookKeyHash: input.webhookKeyHash,
      reason: input.reason,
      companyId: input.companyId ?? null,
      lastIpHash: input.ipHash ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    /*
     * reason is overwritten rather than accumulated: a key that was unknown and
     * later resolves with a bad signature has changed what it is, and the
     * current state is what an operator acts on.
     */
    update: {
      reason: input.reason,
      companyId: input.companyId ?? null,
      lastIpHash: input.ipHash ?? null,
      lastSeenAt: now,
      attemptCount: { increment: 1 },
    },
    /*
     * id only. Postgres requires SELECT on every column a RETURNING clause
     * names, and app_runtime is granted SELECT on this column alone - reading
     * the rest would be enumerating which tenants are failing verification.
     */
    select: { id: true },
  });
}

/*
 * There is deliberately no prune function here.
 *
 * Retention is 30 days and the last_seen_at index supports it, but app_runtime
 * is granted no DELETE on this table - it must not be able to erase the record
 * of deliveries it could not accept, and a tenant request has no business
 * pruning platform evidence. The prune belongs with the admin client, alongside
 * the other cross-company maintenance operations, and arrives with the Phase 12
 * retention work.
 *
 * Shipping a deleteMany() here would have compiled, exported cleanly, and
 * thrown "permission denied" the first time anybody called it.
 */
