import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import {
  leadStatusLabel,
  leadStatusSentence,
  leadStatusVariant,
  type LeadSourceStatusName,
} from "@/lib/lead-source-display";
import { serviceAccountEmail } from "@/lib/lead-sources/credentials";
import { SectionHeader, SectionShell } from "../../_components/section";
import { ServiceAccountPanel } from "./_components/service-account-panel";

export const metadata: Metadata = { title: "Lead sources" };

/**
 * Every bound spreadsheet, and the address they all have to be shared with.
 *
 * The service account panel is at the top rather than tucked into the binding
 * form, because it is needed BEFORE the form is useful: a tenant has to go to
 * Google, share the sheet, and come back. Putting it behind the CTA is asking
 * them to start a form they cannot finish.
 */
export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per segment
   * and is not guaranteed to re-execute, so a check there is one a tenant can
   * navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }

  const [email, sources, sendables] = await Promise.all([
    serviceAccountEmail(session.companyId),
    withCompany(session.companyId, (db) =>
      db.leadSource.findMany({
        /* Tie-broken on id. Two bindings created in one request carry the same
           created_at, so ordering on it alone is a different sequence run to
           run - which a screenshot notices even when a person would not. */
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          tab: true,
          status: true,
          rowsSent: true,
          rowsSeen: true,
          lastSentAt: true,
          lastError: true,
        },
      }),
    ),
    withCompany(session.companyId, async (db) => ({
      templates: await db.whatsAppTemplate.count({ where: { status: "APPROVED" } }),
      numbers: await db.whatsAppNumber.count(),
    })),
  ]);

  const canBind = sendables.templates > 0 && sendables.numbers > 0;

  return (
    <SectionShell>
      <SectionHeader
        title="Lead sources"
        lede="Bind a Google Sheet and every new row becomes a lead. An approved template goes out automatically, through the same send path as everything else."
      />

      <div className="flex flex-col gap-lg">
        <ServiceAccountPanel email={email} />

        {sources.length > 0 ? (
          <div className="flex flex-col gap-base">
            <div className="flex flex-wrap items-center justify-between gap-sm">
              <h2 className="text-title-sm text-ink">Bound sheets</h2>
              {canBind ? (
                <Button asChild>
                  <Link href="/configuration/lead-sources/new">Bind a sheet</Link>
                </Button>
              ) : null}
            </div>

            <ul className="flex flex-col gap-sm">
              {sources.map((source) => (
                <li key={source.id}>
                  <Link
                    href={`/configuration/lead-sources/${source.id}`}
                    className="block rounded-lg border border-hairline bg-surface-card px-base py-base transition-colors hover:border-hairline-strong"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-sm">
                      <div className="min-w-0">
                        <p className="truncate text-body-strong text-ink">
                          {source.name}
                        </p>
                        <p className="mt-xxs truncate text-caption text-muted">
                          Tab: {source.tab}
                        </p>
                      </div>
                      <Badge
                        variant={leadStatusVariant(
                          source.status as LeadSourceStatusName,
                        )}
                      >
                        {leadStatusLabel(source.status as LeadSourceStatusName)}
                      </Badge>
                    </div>

                    <p className="mt-sm text-body-sm text-body">
                      {leadStatusSentence(
                        source.status as LeadSourceStatusName,
                        source.lastError,
                      )}
                    </p>

                    <p className="mt-xs text-caption text-muted">
                      {source.rowsSent.toLocaleString()} sent of{" "}
                      {source.rowsSeen.toLocaleString()} rows read
                      {source.lastSentAt
                        ? ` · last sent ${formatTimestamp(source.lastSentAt)}`
                        : " · nothing sent yet"}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            tone="mint"
            title="No sheets bound yet"
            description={
              canBind
                ? "Share a spreadsheet with the address above, then bind it here. Every row added after that is contacted automatically."
                : "A lead source sends an approved template from one of your numbers, so you need at least one of each before you can bind a sheet."
            }
            action={
              canBind ? (
                <Button asChild>
                  <Link href="/configuration/lead-sources/new">Bind a sheet</Link>
                </Button>
              ) : (
                <Button asChild variant="outline">
                  <Link href="/configuration/templates">Templates</Link>
                </Button>
              )
            }
          />
        )}
      </div>
    </SectionShell>
  );
}
