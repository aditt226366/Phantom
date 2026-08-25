import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Configuration" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="Configuration" />
      <EmptyState
        tone="rose"
        title="Nothing configured yet"
        description="Connect your WhatsApp Business number, set business hours, and choose who is notified when a conversation needs a person."
        /* The one part of this that exists. A dead button was fine while
           nothing was built; now that Numbers is a page, not linking to it
           would leave it reachable only by typing the URL. */
        action={
          <Button asChild>
            <Link href="/configuration/numbers">WhatsApp numbers</Link>
          </Button>
        }
      />
    </SectionShell>
  );
}
