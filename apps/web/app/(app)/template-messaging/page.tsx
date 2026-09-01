import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { flowState, flowStateLabel, flowStateVariant } from "@/lib/flow-display";
import { formatTimestamp } from "@/lib/format";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Template Messaging" };

/** How many flows the list shows before paging would be needed. */
const LIST_LIMIT = 50;

/**
 * Every flow, newest first.
 *
 * Archived ones are included rather than hidden. A flow with runs behind it is
 * the record of what customers were told, and the entry template of an archived
 * flow may still be sitting in a thousand chats - so "why did that stop
 * working" is a question somebody asks about a flow that is no longer live, and
 * a list that hid them would have no answer.
 */
export default async function TemplateMessagingPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }

  const flows = await withCompany(session.companyId, (db, companyId) =>
    db.flow.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        name: true,
        publishedVersionId: true,
        archivedAt: true,
        createdAt: true,
        publishedVersion: { select: { version: true } },
        _count: { select: { runs: true } },
      },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Template Messaging"
        lede="Build a decision tree out of WhatsApp's reply buttons and lists. Every branch is a rule you drew, so the same answer always goes the same way."
      />

      <div className="mb-lg">
        <Button asChild>
          <Link href="/template-messaging/new">New flow</Link>
        </Button>
      </div>

      {flows.length === 0 ? (
        <EmptyState
          tone="lavender"
          title="No flows yet"
          description={EMPTY_COPY["template-messaging"]}
        />
      ) : (
        <ul className="flex flex-col gap-sm">
          {flows.map((flow) => {
            const state = flowState(flow);

            return (
              <li key={flow.id}>
                <Link
                  href={`/template-messaging/${flow.id}`}
                  className="flex flex-wrap items-center justify-between gap-sm rounded-lg border border-hairline bg-surface-card px-base py-base transition-colors hover:border-hairline-strong"
                >
                  <div className="min-w-0">
                    {/* The tenant's own name, so truncated rather than trusted
                        to be short - a grid item's automatic minimum size is
                        the untruncated string, which took the console 90px
                        wide on a phone once already. */}
                    <p className="truncate text-title-sm text-ink">{flow.name}</p>
                    <p className="text-caption text-muted">
                      {flow.publishedVersion
                        ? `Version ${flow.publishedVersion.version} live`
                        : "Never published"}
                      {" · "}
                      {flow._count.runs === 1
                        ? "1 conversation"
                        : `${flow._count.runs} conversations`}
                      {" · "}
                      {formatTimestamp(flow.createdAt)}
                    </p>
                  </div>
                  <Badge variant={flowStateVariant(state)}>
                    {flowStateLabel(state)}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionShell>
  );
}
