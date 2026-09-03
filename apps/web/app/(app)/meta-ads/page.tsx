import type { Metadata } from "next";
import Link from "next/link";
import { listAdAccountRows, listCampaigns, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { formatTimestamp } from "@/lib/format";
import { SectionHeader, SectionShell } from "../_components/section";
import { formatMicros } from "@/lib/meta-ads/budget";
import { PauseForm, PublishForm } from "./_components/campaign-forms";
import { RemoveAccountForm } from "./_components/connect-forms";

export const metadata: Metadata = { title: "Meta Ads" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Meta Ads" />;
  }

  const [accounts, campaigns] = await withCompany(
    session.companyId,
    async (db, companyId) =>
      Promise.all([
        listAdAccountRows(db, companyId),
        listCampaigns(db, companyId),
      ]),
  );

  if (accounts.length === 0) {
    return (
      <SectionShell>
        <SectionHeader title="Meta Ads" />
        <EmptyState
          tone="sky"
          title="No ad account connected"
          description={EMPTY_COPY["meta-ads"]}
          action={
            <Button asChild>
              <Link href="/meta-ads/connect">Connect Meta</Link>
            </Button>
          }
        />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      <SectionHeader
        title="Meta Ads"
        lede="Spend is shown in each account's own currency and is never added across them."
      />

      <div className="flex flex-col gap-base">
        <div>
          <Button asChild variant="outline">
            <Link href="/meta-ads/connect">Connect another account</Link>
          </Button>
        </div>
        {accounts.map((account) => (
          <Card key={account.id} className="flex flex-col gap-sm">
            <div className="flex items-start justify-between gap-base">
              <div>
                <h3 className="font-display text-title-md text-ink">{account.name}</h3>
                <p className="mt-xxs text-caption text-muted">
                  {account.metaAdAccountId} · {account.currency}
                  {account.timezoneName ? ` · ${account.timezoneName}` : ""}
                </p>
              </div>
              <Badge variant={account.whatsappNumberId ? "success" : "outline"}>
                {account.whatsappNumberId ? "REPLIES ARRIVE HERE" : "CHECK PAGE"}
              </Badge>
            </div>

            <p className="text-body-sm text-muted">
              Page: {account.pageName ?? "none selected"}
            </p>

            {/*
              * The warning that has to survive the selection screen.
              *
              * A tenant reads the linked-number message once, while choosing,
              * and then never sees that screen again. If the Page routes
              * replies somewhere we cannot see, the ads keep running and
              * spending for months with nothing arriving - so the state is
              * repeated here, where they will actually be looking when they
              * wonder why the inbox is quiet.
              */}
            {!account.whatsappNumberId ? (
              <p className="rounded-md border border-hairline bg-surface-strong p-sm text-body-sm text-error">
                {account.linkedPhoneE164
                  ? `This account's Page sends replies to ${account.linkedPhoneE164}, which is not one of your numbers. Ads will run and spend, but the conversations they start will not appear in this inbox.`
                  : "This account's Page has no WhatsApp number linked to it, so click-to-WhatsApp ads from it have nowhere to send people."}
              </p>
            ) : null}

            <p className="text-caption text-muted">
              {/*
                * An age, not an instant, and it is safe to render because the
                * fixture can seed it relative to now(). The rule the
                * conventions state: which column may be seeded from the clock
                * is decided by what RENDERS it.
                */}
              Spend last read {formatTimestamp(account.insightsSyncedAt)}
            </p>

            <RemoveAccountForm csrf={<CsrfField />} id={account.id} />
          </Card>
        ))}
      </div>

      <div className="mt-lg flex flex-col gap-base">
        <div className="flex items-center justify-between gap-base">
          <h2 className="font-display text-title-md text-ink">Campaigns</h2>
          <Button asChild variant="outline">
            <Link href="/meta-ads/campaigns/new">New campaign</Link>
          </Button>
        </div>

        {campaigns.length === 0 ? (
          <Card>
            <p className="text-body-sm text-muted">
              No campaigns yet. A campaign created here is paused, and stays
              paused until you publish it.
            </p>
          </Card>
        ) : (
          campaigns.map((campaign) => (
            <Card key={campaign.id} className="flex flex-col gap-sm">
              <div className="flex items-start justify-between gap-base">
                <div>
                  <h3 className="font-display text-title-md text-ink">
                    {campaign.name}
                  </h3>
                  <p className="mt-xxs text-caption text-muted">
                    {campaign.dailyBudgetMicros === null
                      ? "No daily budget"
                      : `${formatMicros(campaign.dailyBudgetMicros, campaign.currency)} a day`}
                  </p>
                </div>
                {/*
                  * The badge reads the stored status, never an optimistic
                  * flip. An operator acts on it, and a campaign that claims
                  * ACTIVE because the browser assumed so is worse than one
                  * that takes a moment to say PAUSED.
                  */}
                <Badge variant={campaign.status === "ACTIVE" ? "success" : "outline"}>
                  {campaign.status}
                </Badge>
              </div>

              {campaign.status === "ACTIVE" ? (
                <PauseForm csrf={<CsrfField />} id={campaign.id} />
              ) : (
                <PublishForm
                  csrf={<CsrfField />}
                  id={campaign.id}
                  name={campaign.name}
                />
              )}
            </Card>
          ))
        )}
      </div>
    </SectionShell>
  );
}
