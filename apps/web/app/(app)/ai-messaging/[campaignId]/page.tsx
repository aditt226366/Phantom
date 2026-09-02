import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import {
  campaignControls,
  campaignStatusLabel,
  campaignStatusVariant,
  scheduleSummary,
  tierLabel,
  type CampaignStatus,
} from "@/lib/verse-display";
import { SectionHeader, SectionShell } from "../../_components/section";
import {
  ArchiveButton,
  AudienceForm,
  DuplicateButton,
  PauseButton,
  ResumeButton,
  StartButton,
} from "../_components/campaign-forms";

export const metadata: Metadata = { title: "Campaign" };

/**
 * One campaign: what it is doing, and the controls it has.
 *
 * The counts are read per request rather than rolled up, because a person on
 * this page is usually watching a campaign they have just started or just
 * paused - and a figure a minute old on that screen reads as the control not
 * having worked.
 */
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }

  const { campaignId } = await params;

  const campaign = await withCompany(session.companyId, async (db) => {
    const row = await db.verseCampaign.findFirst({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        goal: true,
        status: true,
        stoppedReason: true,
        modelTier: true,
        timezone: true,
        dailyWindowStartMinute: true,
        dailyWindowEndMinute: true,
        dailyCap: true,
        knowledgeBase: { select: { id: true, name: true } },
        template: { select: { name: true, language: true, status: true } },
        whatsappNumber: { select: { displayNumber: true } },
      },
    });

    if (!row) return null;

    /*
     * Counted by status in one pass rather than four. groupBy is one round
     * trip and the four numbers then describe the same instant - four separate
     * counts would let a tick land between them and produce a breakdown that
     * does not add up.
     */
    const byStatus = await db.verseCampaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: row.id },
      _count: { _all: true },
    });

    return { ...row, byStatus };
  });

  /* Rule 6: not yours means it does not exist. Never a 403. */
  if (!campaign) notFound();

  const status = campaign.status as CampaignStatus;
  const controls = campaignControls(status);

  const count = (name: string) =>
    campaign.byStatus.find((row) => row.status === name)?._count._all ?? 0;

  return (
    <SectionShell>
      <SectionHeader title={campaign.name} />

      <div className="mb-lg flex flex-wrap items-center gap-sm">
        <Badge variant={campaignStatusVariant(status)}>
          {campaignStatusLabel(status)}
        </Badge>
        {controls.canStart ? (
          <StartButton campaignId={campaign.id} csrf={<CsrfField />} />
        ) : null}
        {controls.canPause ? (
          <PauseButton campaignId={campaign.id} csrf={<CsrfField />} />
        ) : null}
        {controls.canResume ? (
          <ResumeButton campaignId={campaign.id} csrf={<CsrfField />} />
        ) : null}
        {controls.canDuplicate ? (
          <DuplicateButton campaignId={campaign.id} csrf={<CsrfField />} />
        ) : null}
        {controls.canArchive ? (
          <ArchiveButton campaignId={campaign.id} csrf={<CsrfField />} />
        ) : null}
      </div>

      {/*
        Why it stopped, first and in full.

        A campaign Meta stopped is the only state on this page that needs
        acting on, and there is deliberately no Resume beside it - resuming
        would put it straight back into refusing one message at a time. The
        sentence names what to do instead.
      */}
      {campaign.stoppedReason ? (
        <Card className="mb-lg">
          <p className="text-body-sm font-medium">This campaign stopped itself</p>
          <p className="mt-xs text-caption text-error">
            {campaign.stoppedReason}
          </p>
        </Card>
      ) : null}

      <div className="grid gap-md sm:grid-cols-2">
        <Card>
          <h2 className="text-title-sm">What it is for</h2>
          {/*
            The goal as written, in a pre-wrap block. Verse is given this
            verbatim, so showing it reformatted would misrepresent what the
            model was actually asked to do.
          */}
          <p className="mt-sm whitespace-pre-wrap text-body-sm text-body">
            {campaign.goal}
          </p>
        </Card>

        <Card>
          <h2 className="text-title-sm">How it runs</h2>
          <dl className="mt-sm flex flex-col gap-xs text-caption">
            <div className="flex justify-between gap-sm">
              <dt className="text-muted">Model</dt>
              <dd>{tierLabel(campaign.modelTier)}</dd>
            </div>
            <div className="flex justify-between gap-sm">
              <dt className="text-muted">Answers from</dt>
              <dd className="min-w-0 truncate">
                <Link
                  href="/ai-messaging/knowledge"
                  className="hover:underline"
                >
                  {campaign.knowledgeBase.name}
                </Link>
              </dd>
            </div>
            <div className="flex justify-between gap-sm">
              <dt className="text-muted">Opens with</dt>
              <dd className="min-w-0 truncate">
                {campaign.template.name} ({campaign.template.status})
              </dd>
            </div>
            <div className="flex justify-between gap-sm">
              <dt className="text-muted">Sends from</dt>
              <dd>{campaign.whatsappNumber?.displayNumber ?? "Not set"}</dd>
            </div>
            <div className="flex justify-between gap-sm">
              <dt className="text-muted">Schedule</dt>
              <dd className="min-w-0 text-right">
                {scheduleSummary(
                  campaign.timezone,
                  campaign.dailyWindowStartMinute,
                  campaign.dailyWindowEndMinute,
                  campaign.dailyCap,
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card className="mt-md">
        <h2 className="text-title-sm">Audience</h2>
        <dl className="mt-sm grid grid-cols-2 gap-sm text-caption sm:grid-cols-4">
          {[
            ["Waiting", count("PENDING")],
            ["Messaged", count("SENT")],
            ["Skipped", count("SKIPPED")],
            ["Failed", count("FAILED")],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt className="text-muted">{label}</dt>
              <dd className="text-title-sm">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-md border-t border-hairline pt-md">
          <AudienceForm campaignId={campaign.id} csrf={<CsrfField />} />
        </div>

        <p className="mt-sm text-caption text-muted">
          Skipped includes people who opted out, and anyone already in a
          conversation your team or another automation was handling — a campaign
          never interrupts one.
        </p>
      </Card>
    </SectionShell>
  );
}
