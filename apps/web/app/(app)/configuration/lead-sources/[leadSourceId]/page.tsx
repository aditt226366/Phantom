import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { appsScriptSource, leadSourceWebhookUrl } from "@whatsapp-os/core/leads";
import { recentLeadRows, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatTimestamp } from "@/lib/format";
import {
  leadRowOutcome,
  leadStatusLabel,
  leadStatusSentence,
  leadStatusVariant,
  rejectBreakdown,
  sheetUrl,
  type LeadSourceStatusName,
} from "@/lib/lead-source-display";
import { serviceAccountEmail } from "@/lib/lead-sources/credentials";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { AppsScriptPanel } from "../_components/apps-script-panel";
import { BindingControls } from "../_components/binding-controls";
import { ServiceAccountPanel } from "../_components/service-account-panel";

export const metadata: Metadata = { title: "Lead source" };

/** How many recent rows the live feed shows. */
const FEED_ROWS = 12;

/**
 * One binding: what it has done, and what is wrong with it.
 *
 * The error state is the reason this page has a designed empty case rather
 * than a banner. A binding that has lost access to its sheet is indistinguishable
 * from one with no new leads - both show nothing happening - and the difference
 * is a customer list nobody is being contacted from. So the state is the first
 * thing on the page, in its own plate, with Google's own sentence under it.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ leadSourceId: string }>;
}) {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }

  const { leadSourceId } = await params;

  const data = await withCompany(session.companyId, async (db, companyId) => {
    const binding = await db.leadSource.findFirst({
      where: { id: leadSourceId },
      select: {
        id: true,
        name: true,
        spreadsheetId: true,
        tab: true,
        sheetGid: true,
        status: true,
        pollIntervalSeconds: true,
        webhookKey: true,
        rowsSeen: true,
        rowsSent: true,
        rowsSkipped: true,
        rowsRejected: true,
        rowsDuplicate: true,
        rejectReasons: true,
        lastPolledAt: true,
        lastSentAt: true,
        lastError: true,
        backoffUntil: true,
        template: { select: { name: true, language: true } },
      },
    });

    if (!binding) return null;

    return {
      binding,
      rows: await recentLeadRows(db, companyId, leadSourceId, FEED_ROWS),
    };
  });

  /* Rule 6: a binding that is not yours does not exist. */
  if (!data) notFound();

  const { binding, rows } = data;
  const status = binding.status as LeadSourceStatusName;
  const rejects = rejectBreakdown(binding.rejectReasons);

  /*
   * The address to share with, but only while something is wrong.
   *
   * A tenant reading "we cannot see that spreadsheet" needs it in front of
   * them, and the alternative is a sentence that tells them to go and find it
   * on another page. On a healthy binding it would be clutter - the setup is
   * done and nobody is going to re-share a sheet that is working.
   */
  const email = status === "ERROR" ? await serviceAccountEmail(session.companyId) : null;

  /* Per binding, so deleting this lead source revokes exactly its own script -
     and so rotating it cannot silently break the WhatsApp webhook, which lives
     in a different column entirely. */
  const webhookUrl = leadSourceWebhookUrl(env.APP_URL, binding.webhookKey);

  return (
    <SectionShell>
      <SectionHeader
        title={binding.name}
        lede={`${binding.template?.name ?? "No template"} · tab ${binding.tab} · every ${binding.pollIntervalSeconds} seconds`}
      />

      <div className="flex flex-col gap-lg">
        <section
          className={
            status === "ERROR"
              ? "rounded-lg border border-hairline-strong bg-surface-strong px-base py-base"
              : "rounded-lg border border-hairline bg-surface-card px-base py-base"
          }
        >
          <div className="flex flex-wrap items-center gap-sm">
            <Badge variant={leadStatusVariant(status)}>
              {leadStatusLabel(status)}
            </Badge>
            {binding.lastPolledAt ? (
              <span className="text-caption text-muted">
                Last looked {formatTimestamp(binding.lastPolledAt)}
              </span>
            ) : (
              <span className="text-caption text-muted">Not looked yet</span>
            )}
          </div>

          <p className="mt-sm max-w-2xl text-body-sm text-body">
            {leadStatusSentence(status, binding.lastError)}
          </p>

          <div className="mt-base flex flex-wrap items-center gap-sm">
            <BindingControls
              leadSourceId={binding.id}
              name={binding.name}
              enabled={status === "ACTIVE"}
              csrf={<CsrfField />}
            />
            <Button asChild variant="outline">
              <Link href={`/configuration/lead-sources/${binding.id}/map`}>
                Change the mapping
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <a
                href={sheetUrl(binding.spreadsheetId, binding.sheetGid)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in Google Sheets
              </a>
            </Button>
          </div>
        </section>

        {status === "ERROR" ? <ServiceAccountPanel email={email} /> : null}

        <AppsScriptPanel
          source={appsScriptSource(webhookUrl)}
          url={webhookUrl}
        />

        <section className="grid gap-sm tablet:grid-cols-2 desktop:grid-cols-4">
          <Stat label="Rows read" value={binding.rowsSeen} />
          <Stat label="Messages sent" value={binding.rowsSent} />
          <Stat label="Skipped" value={binding.rowsSkipped} />
          <Stat label="Rejected" value={binding.rowsRejected} />
        </section>

        {rejects.length > 0 || binding.rowsDuplicate > 0 ? (
          <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">Rows that produced nothing</h2>
            <ul className="mt-base flex flex-col gap-xs">
              {rejects.map((reject) => (
                <li
                  key={reject.reason}
                  className="flex flex-wrap items-baseline justify-between gap-sm border-b border-hairline-soft pb-xs"
                >
                  <span className="text-body-sm text-body">{reject.label}</span>
                  <span className="text-body-strong text-ink">
                    {reject.count.toLocaleString()}
                  </span>
                </li>
              ))}
              {binding.rowsDuplicate > 0 ? (
                <li className="flex flex-wrap items-baseline justify-between gap-sm">
                  <span className="text-body-sm text-body">
                    Already sent from this spreadsheet
                  </span>
                  <span className="text-body-strong text-ink">
                    {binding.rowsDuplicate.toLocaleString()}
                  </span>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <h2 className="text-title-sm text-ink">Recent leads</h2>

          {rows.length === 0 ? (
            <p className="mt-base text-body-sm text-body">
              Nothing yet. Rows added to the sheet from now on appear here,
              newest first.
            </p>
          ) : (
            <ul className="mt-base flex flex-col gap-xs">
              {rows.map((row) => {
                const outcome = leadRowOutcome(row);

                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-sm border-b border-hairline-soft pb-sm last:border-b-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-body-sm text-ink">
                        {row.phoneE164}
                      </p>
                      <p className="mt-xxs text-caption text-muted">
                        {formatTimestamp(row.createdAt)}
                      </p>
                    </div>
                    <Badge variant={outcome.variant}>{outcome.label}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div>
          <Button asChild variant="ghost">
            <Link href="/configuration/lead-sources">Back to lead sources</Link>
          </Button>
        </div>
      </div>
    </SectionShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-card px-base py-sm">
      <p className="text-caption-uppercase text-muted">{label}</p>
      <p className="mt-xxs text-display-sm text-ink">{value.toLocaleString()}</p>
    </div>
  );
}
