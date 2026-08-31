import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { SectionHeader, SectionShell } from "../_components/section";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Configuration" };

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
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }


  return (
    <SectionShell>
      <SectionHeader title="Configuration" />
      <EmptyState
        tone="rose"
        title="Nothing configured yet"
        description={EMPTY_COPY.configuration}
        /* The one part of this that exists. A dead button was fine while
           nothing was built; now that Numbers is a page, not linking to it
           would leave it reachable only by typing the URL. */
        /*
           The three parts of this that exist. Templates moved here because a
           template is a shared asset - the inbox picker, bulk messaging and
           the flow builder all draw on the same approved set - and a shared
           asset is configuration rather than a section of its own.

           Lead sources are here for the same reason and a second one: a bound
           spreadsheet is a standing arrangement rather than a campaign, so it
           belongs beside the numbers and the templates it depends on rather
           than in the nav next to things somebody starts by hand.
        */
        action={
          <div className="flex flex-wrap items-center justify-center gap-xs">
            <Button asChild>
              <Link href="/configuration/numbers">WhatsApp numbers</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/configuration/templates">Templates</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/configuration/lead-sources">Lead sources</Link>
            </Button>
          </div>
        }
      />
    </SectionShell>
  );
}
