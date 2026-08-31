import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { SectionHeader, SectionShell } from "../_components/section";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "AI Messaging" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }


  return (
    <SectionShell>
      <SectionHeader title="AI Messaging" />
      <EmptyState
        tone="mint"
        title="No campaigns yet"
        description={EMPTY_COPY["ai-messaging"]}
          action={<Button>Create campaign</Button>}
      />
    </SectionShell>
  );
}
