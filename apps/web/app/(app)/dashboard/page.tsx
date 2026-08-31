import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="The dashboard" />;
  }


  return (
    <SectionShell>
      <SectionHeader
        title={`Welcome, ${session.user.fullName.split(" ")[0]}`}
        lede={`${session.company.name} is set up. There is nothing to report until something has been sent.`}
      />
      <EmptyState
        tone="mint"
        title="Nothing to report yet"
        description="Delivery rates, reply volume and ad spend appear here once your first campaign has run."
        action={<Button>Create campaign</Button>}
      />
    </SectionShell>
  );
}
