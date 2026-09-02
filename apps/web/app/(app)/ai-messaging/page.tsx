import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { requireSession } from "@/lib/auth/session";
import {
  campaignStatusLabel,
  campaignStatusVariant,
  scheduleSummary,
  tierLabel,
  type CampaignStatus,
} from "@/lib/verse-display";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "AI Messaging" };

const LIST_LIMIT = 50;

/**
 * Every campaign, newest first.
 *
 * Archived ones are included rather than hidden, for the reason the flow list
 * includes archived flows: a campaign that contacted people is the record of
 * who was messaged and what they were told, and the conversations it opened
 * outlive it. "Why did that customer get this" is a question asked about a
 * campaign that is no longer running.
 */
export default async function AiMessagingPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }

  const campaigns = await withCompany(session.companyId, (db, companyId) =>
    db.verseCampaign.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        name: true,
        status: true,
        stoppedReason: true,
        modelTier: true,
        timezone: true,
        dailyWindowStartMinute: true,
        dailyWindowEndMinute: true,
        dailyCap: true,
        knowledgeBase: { select: { name: true } },
        _count: { select: { recipients: true } },
      },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="AI Messaging"
        lede="Campaigns that open a conversation and answer what comes back, from your knowledge base and nothing else."
      />

      {campaigns.length === 0 ? (
        <EmptyState
          tone="mint"
          title="No campaigns yet"
          /*
           * From EMPTY_COPY rather than written here. That module is the one
           * place a section's empty-state sentence lives, and shell.test.ts
           * asserts every key is reachable from the page it names - so copy
           * duplicated inline would leave the shared one describing a section
           * nothing renders it in.
           *
           * It was written when this section was a stub and describes exactly
           * what shipped, so there was nothing to change.
           */
          description={EMPTY_COPY["ai-messaging"]}
          action={
            <div className="flex flex-wrap justify-center gap-sm">
              <Button asChild>
                <Link href="/ai-messaging/new">Create campaign</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/ai-messaging/knowledge">Knowledge base</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="mb-lg flex flex-wrap gap-sm">
            <Button asChild>
              <Link href="/ai-messaging/new">Create campaign</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/ai-messaging/knowledge">Knowledge base</Link>
            </Button>
          </div>

          <ul className="flex flex-col gap-md">
            {campaigns.map((campaign) => {
              const status = campaign.status as CampaignStatus;

              return (
                <li key={campaign.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-sm">
                      <div className="min-w-0">
                        <Link
                          href={`/ai-messaging/${campaign.id}`}
                          className="text-title-sm hover:underline"
                        >
                          {campaign.name}
                        </Link>
                        <p className="mt-xs text-caption text-muted">
                          {tierLabel(campaign.modelTier)} ·{" "}
                          {campaign.knowledgeBase.name} ·{" "}
                          {campaign._count.recipients === 1
                            ? "1 recipient"
                            : `${campaign._count.recipients} recipients`}
                        </p>
                        <p className="text-caption text-muted">
                          {scheduleSummary(
                            campaign.timezone,
                            campaign.dailyWindowStartMinute,
                            campaign.dailyWindowEndMinute,
                            campaign.dailyCap,
                          )}
                        </p>
                      </div>
                      <Badge variant={campaignStatusVariant(status)}>
                        {campaignStatusLabel(status)}
                      </Badge>
                    </div>

                    {/*
                      Why it stopped, in full and on the list.
                      A campaign Meta stopped mid-flight is the one thing on
                      this page somebody needs to act on, and requiring a click
                      to find out why would leave it looking like an ordinary
                      finished campaign.
                    */}
                    {campaign.stoppedReason ? (
                      <p className="mt-sm text-caption text-error">
                        {campaign.stoppedReason}
                      </p>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </SectionShell>
  );
}
