import type { Metadata } from "next";
import Link from "next/link";
import { whatsappNumbersForMatching, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { loadMetaAdsCredentials } from "@/lib/meta-ads/credentials";
import { readAdAccounts, readPageWhatsAppLink, readPages } from "@/lib/meta-ads/graph";
import { checkLinkedNumber, linkedNumberMessage } from "@/lib/meta-ads/linked-number";
import { SectionHeader, SectionShell } from "../../_components/section";
import { ConnectForm, type PageOption } from "../_components/connect-forms";

export const metadata: Metadata = { title: "Connect Meta Ads" };

/**
 * The one screen in this section that calls Meta before it can render.
 *
 * It reads through lib/meta-ads/graph, which answers from a literal when
 * META_ADS_FIXTURE holds its sentinel - set by playwright.config.ts and by
 * nothing else. Without that the gate would spend two ten-second provider
 * timeouts per run photographing an error state, and the screen where a tenant
 * decides which account spends their money would be the one screen never
 * looked at.
 */
export default async function Page() {
  const session = await requireSession();
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Meta Ads" />;
  }

  const credentials = await loadMetaAdsCredentials(session.companyId);

  if (!credentials) {
    return (
      <SectionShell>
        <SectionHeader title="Connect Meta Ads" />
        <EmptyState
          tone="sky"
          title="No Meta credentials stored"
          description="Your Meta access token and ad account are held for you by your platform contact. Ask them to add the Meta Ads credentials for this workspace, then come back here to choose an account."
          action={
            <Button asChild variant="outline">
              <Link href="/meta-ads">Back to Meta Ads</Link>
            </Button>
          }
        />
      </SectionShell>
    );
  }

  const [accounts, pages, ownNumbers] = await Promise.all([
    readAdAccounts(credentials.accessToken),
    readPages(credentials.accessToken),
    withCompany(session.companyId, (db, companyId) =>
      whatsappNumbersForMatching(db, companyId),
    ),
  ]);

  if (!accounts.ok || !pages.ok) {
    /* Narrowed by hand: the union of two GraphResults does not carry the
       knowledge that whichever one we picked is the failing member. */
    const failure = !accounts.ok ? accounts : (pages as { error: string });
    return (
      <SectionShell>
        <SectionHeader title="Connect Meta Ads" />
        <EmptyState
          tone="sky"
          title="Meta did not answer"
          /*
           * The provider's own message, already scrubbed by the decoder. It is
           * shown rather than replaced with something generic because the
           * useful cases are all specific - an expired token, an account with
           * no ads permission - and a tenant who cannot see which one has
           * nothing to act on.
           */
          description={failure.error}
          action={
            <Button asChild variant="outline">
              <Link href="/meta-ads">Back to Meta Ads</Link>
            </Button>
          }
        />
      </SectionShell>
    );
  }

  /*
   * One Page lookup each, in parallel, so the warning is ready before anybody
   * chooses. Doing it on selection instead would mean the tenant learns that
   * replies go somewhere else AFTER committing - which is the wrong order for
   * the only irreversible thing on this screen.
   */
  const pageOptions: PageOption[] = await Promise.all(
    pages.data.map(async (page): Promise<PageOption> => {
      const link = await readPageWhatsAppLink(page.id, credentials.accessToken);
      const verdict = checkLinkedNumber(
        link.ok ? link.data.phoneNumber : null,
        ownNumbers,
      );

      return {
        id: page.id,
        name: page.name,
        linkMessage: linkedNumberMessage(verdict),
        linkKind: verdict.kind,
      };
    }),
  );

  return (
    <SectionShell>
      <SectionHeader title="Connect Meta Ads" />

      {accounts.data.length === 0 ? (
        <EmptyState
          tone="sky"
          title="This connection reaches no ad accounts"
          description="The stored Meta token can sign in, but it administers no ad accounts. Check in Meta Business Manager that the person who issued it has access to the account you want to use."
        />
      ) : (
        <Card className="flex flex-col gap-base">
          <p className="text-body-sm text-muted">
            Choose the ad account whose spend you want to see here, and the Page
            your click-to-WhatsApp ads post from. You can change both later.
          </p>

          <ConnectForm
            csrf={<CsrfField />}
            accounts={accounts.data.map((account) => ({
              id: account.id,
              name: account.name,
              currency: account.currency,
              accountStatus: account.accountStatus,
            }))}
            pages={pageOptions}
          />
        </Card>
      )}
    </SectionShell>
  );
}
