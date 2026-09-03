import type { Metadata } from "next";
import Link from "next/link";
import { listAdAccountRows, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { NewCampaignForm } from "../../_components/campaign-forms";

export const metadata: Metadata = { title: "New campaign" };

export default async function Page() {
  const session = await requireSession();
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Meta Ads" />;
  }

  const accounts = await withCompany(session.companyId, (db, companyId) =>
    listAdAccountRows(db, companyId),
  );

  if (accounts.length === 0) {
    return (
      <SectionShell>
        <SectionHeader title="New campaign" />
        <EmptyState
          tone="sky"
          title="Connect an ad account first"
          description="A campaign belongs to an ad account, and its budget is denominated in that account's currency. Connect one and come back."
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
        title="New campaign"
        lede="Nothing on this page starts spending. A campaign is created paused and publishing it is a separate, deliberate step."
      />

      <Card className="flex flex-col gap-base">
        <NewCampaignForm
          csrf={<CsrfField />}
          accounts={accounts.map((account) => ({
            id: account.id,
            name: account.name,
            currency: account.currency,
          }))}
        />
      </Card>
    </SectionShell>
  );
}
