import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Inbox" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="Inbox" />
      <EmptyState
        tone="mint"
        title="Nothing in the inbox"
        description="Replies from your contacts arrive here. Conversations Verse cannot answer are handed over with the history attached."

      />
    </SectionShell>
  );
}
