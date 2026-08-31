import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { requireSession } from "@/lib/auth/session";
import {
  broadcastStatusLabel,
  broadcastStatusVariant,
} from "@/lib/bulk-display";
import { formatTimestamp } from "@/lib/format";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Bulk Messaging" };

/** How many broadcasts the history shows before paging would be needed. */
const HISTORY_LIMIT = 50;

/**
 * Every broadcast, newest first.
 *
 * History is retained rather than trimmed. A broadcast is the record of what a
 * business said to thousands of its customers, and "what did we send in
 * October" is a question somebody asks months later - usually because a
 * customer is quoting it back at them.
 */
export default async function BulkMessagingPage() {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Bulk Messaging" />;
  }

  const broadcasts = await withCompany(session.companyId, (db, companyId) =>
    db.broadcast.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: {
        id: true,
        name: true,
        status: true,
        recipientCount: true,
        createdAt: true,
        startedAt: true,
        template: { select: { name: true } },
      },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Bulk Messaging"
        lede="Send an approved template to a list of contacts, at a controlled pace."
      />

      <div className="mb-lg">
        <Button asChild>
          <Link href="/bulk-messaging/new">New broadcast</Link>
        </Button>
      </div>

      {broadcasts.length === 0 ? (
        <EmptyState
          tone="lavender"
          title="Nothing sent yet"
          description={EMPTY_COPY["bulk-messaging"]}
        />
      ) : (
        <ul className="flex flex-col gap-sm">
          {broadcasts.map((broadcast) => (
            <li key={broadcast.id}>
              <Link
                href={`/bulk-messaging/${broadcast.id}`}
                className="flex flex-wrap items-center justify-between gap-sm rounded-lg border border-hairline bg-surface-card px-base py-base transition-colors hover:border-hairline-strong"
              >
                <div className="min-w-0">
                  {/* The tenant's own name for it, so truncated rather than
                      trusted to be short - R4's automatic minimum size hazard. */}
                  <p className="truncate text-title-sm text-ink">
                    {broadcast.name}
                  </p>
                  <p className="text-caption text-muted">
                    {broadcast.template.name} ·{" "}
                    {broadcast.recipientCount.toLocaleString()}{" "}
                    {broadcast.recipientCount === 1 ? "person" : "people"} ·{" "}
                    {formatTimestamp(broadcast.startedAt ?? broadcast.createdAt)}
                  </p>
                </div>

                <Badge variant={broadcastStatusVariant(broadcast.status)}>
                  {broadcastStatusLabel(broadcast.status)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}
