import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Template Messaging" };

/**
 * Reserved for the flow builder, which is amendment A1.
 *
 * This section used to hold the Template Studio. The Studio moved to
 * Configuration > Templates because a template is a shared asset - the inbox
 * picker, bulk messaging and eventually the flow builder all draw on the same
 * approved templates - and a shared asset belongs in configuration rather than
 * owning a section.
 *
 * What A1 reserves this name for is different: a visual builder of decision
 * trees made of WhatsApp's interactive messages, with a runtime engine behind
 * it. That is a phase, not a page, so this says what is coming and points at
 * the thing people arriving here are most likely to actually want.
 *
 * The link matters more than the copy. Anybody who bookmarked the Studio lands
 * here, and a page that only described a future feature would leave them
 * hunting for something that still exists.
 */
export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }

  return (
    <SectionShell>
      <SectionHeader title="Template Messaging" />
      <EmptyState
        tone="lavender"
        title="Flow builder arrives in a later phase"
        description={EMPTY_COPY["template-messaging"]}
        action={
          <Button asChild>
            <Link href="/configuration/templates">Go to Templates</Link>
          </Button>
        }
      />
    </SectionShell>
  );
}
