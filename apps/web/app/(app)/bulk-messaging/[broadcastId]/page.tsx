import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { broadcastProgress, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import {
  broadcastStatusLabel,
  broadcastStatusVariant,
  deliveryLabel,
  isLive,
  orderDeliveryStatuses,
  runControls,
} from "@/lib/bulk-display";
import { formatTimestamp } from "@/lib/format";
import { SectionHeader, SectionShell } from "../../_components/section";
import { RunControls } from "../_components/run-controls";

export const metadata: Metadata = { title: "Broadcast" };

/* A running broadcast changes while it is being watched. */
export const dynamic = "force-dynamic";

/**
 * What happened to every recipient.
 *
 * The failure list is grouped by the sentence rather than listed per message,
 * because ten thousand recipients produce at most a handful of distinct
 * reasons and a page listing them one per row is one nobody scrolls. Grouped,
 * the shape of a bad run is visible in three lines: 8,400 delivered, 900 rate
 * limited, 12 unreachable.
 */
export default async function BroadcastPage({
  params,
}: {
  params: Promise<{ broadcastId: string }>;
}) {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Bulk Messaging" />;
  }

  const { broadcastId } = await params;

  const data = await withCompany(session.companyId, async (db, companyId) => {
    const broadcast = await db.broadcast.findFirst({
      where: { id: broadcastId, companyId },
      select: {
        id: true,
        name: true,
        status: true,
        gapMs: true,
        recipientCount: true,
        parsedCount: true,
        invalidCount: true,
        duplicateCount: true,
        optedOutCount: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        whatsappNumber: { select: { displayNumber: true } },
        template: { select: { name: true, language: true } },
      },
    });

    if (!broadcast) return null;

    /* A draft has no report yet - it has a confirm screen. */
    if (broadcast.status === "DRAFT") return { broadcast, progress: null };

    const progress = await broadcastProgress(db, companyId, broadcastId);

    return { broadcast, progress };
  });

  if (!data) notFound();

  const { broadcast, progress } = data;

  if (!progress) {
    /* Still a draft. Send them where the decision is, rather than showing an
       empty report for a broadcast that has not started. */
    return (
      <SectionShell>
        <SectionHeader title={broadcast.name} />
        <p className="text-body-sm text-body">
          This broadcast has not been sent yet.{" "}
          <Link
            href={`/bulk-messaging/${broadcast.id}/confirm`}
            className="underline underline-offset-4"
          >
            Review and send it
          </Link>
          .
        </p>
      </SectionShell>
    );
  }

  const controls = runControls(broadcast.status);
  const statuses = orderDeliveryStatuses(Object.keys(progress.byStatus));

  return (
    <SectionShell>
      <SectionHeader
        title={broadcast.name}
        lede={`${broadcast.template.name} (${broadcast.template.language}) from ${broadcast.whatsappNumber.displayNumber}, to ${broadcast.recipientCount.toLocaleString()} people.`}
      />

      <div className="flex flex-col gap-lg">
        <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <div className="flex flex-wrap items-start justify-between gap-sm">
            <div>
              <Badge variant={broadcastStatusVariant(broadcast.status)}>
                {broadcastStatusLabel(broadcast.status)}
              </Badge>
              <p className="mt-xs text-body-sm text-body">
                {broadcast.startedAt
                  ? `Started ${formatTimestamp(broadcast.startedAt)}`
                  : `Created ${formatTimestamp(broadcast.createdAt)}`}
                {broadcast.finishedAt
                  ? ` · finished ${formatTimestamp(broadcast.finishedAt)}`
                  : null}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-xs">
              <Button asChild variant="outline" size="sm">
                {/* Not a Link: typedRoutes types the app's own routes, and an
                    /api path is not one of them. */}
                <a href={`/api/broadcasts/${broadcast.id}/report`}>
                  Download report
                </a>
              </Button>

              {isLive(broadcast.status) ? (
                <RunControls
                  broadcastId={broadcast.id}
                  controls={controls}
                  csrf={<CsrfField />}
                />
              ) : null}
            </div>
          </div>

          {/* The funnel. Queued first, because on a running broadcast it is the
              number that answers "how far has this got". */}
          <ul className="mt-base flex flex-wrap gap-lg">
            <li>
              <p className="text-caption-uppercase uppercase text-muted">
                Queued
              </p>
              <p className="text-title-sm text-ink">
                {progress.queued.toLocaleString()}
              </p>
            </li>
            {statuses.map((status) => (
              <li key={status}>
                <p className="text-caption-uppercase uppercase text-muted">
                  {deliveryLabel(status)}
                </p>
                <p className="text-title-sm text-ink">
                  {(progress.byStatus[status] ?? 0).toLocaleString()}
                </p>
              </li>
            ))}
            {progress.skipped > 0 ? (
              <li>
                <p className="text-caption-uppercase uppercase text-muted">
                  Skipped
                </p>
                <p className="text-title-sm text-ink">
                  {progress.skipped.toLocaleString()}
                </p>
              </li>
            ) : null}
          </ul>
        </section>

        {progress.failures.length > 0 ? (
          <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">Why messages failed</h2>
            <p className="mt-xxs text-body-sm text-body">
              Grouped by reason. The same wording appears on each failed message
              in the inbox.
            </p>

            <ul className="mt-base flex flex-col gap-sm">
              {progress.failures.map((failure) => (
                <li
                  key={failure.title}
                  className="flex flex-wrap items-start justify-between gap-sm rounded-md border border-hairline-strong bg-surface-strong px-base py-sm"
                >
                  <p className="min-w-0 flex-1 text-body-sm text-body">
                    {failure.title}
                  </p>
                  <p className="shrink-0 text-title-sm text-error">
                    {failure.count.toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <h2 className="text-title-sm text-ink">The list</h2>
          <ul className="mt-base flex flex-wrap gap-lg">
            <li>
              <p className="text-caption-uppercase uppercase text-muted">
                Rows in the file
              </p>
              <p className="text-title-sm text-ink">
                {broadcast.parsedCount.toLocaleString()}
              </p>
            </li>
            <li>
              <p className="text-caption-uppercase uppercase text-muted">
                No usable number
              </p>
              <p className="text-title-sm text-ink">
                {broadcast.invalidCount.toLocaleString()}
              </p>
            </li>
            <li>
              <p className="text-caption-uppercase uppercase text-muted">
                Duplicates
              </p>
              <p className="text-title-sm text-ink">
                {broadcast.duplicateCount.toLocaleString()}
              </p>
            </li>
            <li>
              <p className="text-caption-uppercase uppercase text-muted">
                Opted out
              </p>
              <p className="text-title-sm text-ink">
                {broadcast.optedOutCount.toLocaleString()}
              </p>
            </li>
          </ul>
        </section>
      </div>
    </SectionShell>
  );
}
