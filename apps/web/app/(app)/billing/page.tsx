import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Billing" };

/**
 * Coming soon, and nothing else.
 *
 * Deliberately not an EmptyState with an action: there is nothing to do here
 * yet, and offering a button that does nothing is worse than an honest blank.
 */
export default async function BillingPage() {
  await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Billing" />;
  }


  return (
    <SectionShell>
      <SectionHeader title="Billing" />
      <div className="rounded-xl border border-hairline bg-surface-card px-lg py-xxl text-center">
        <p className="text-display-sm text-ink">Coming soon</p>
      </div>
    </SectionShell>
  );
}
