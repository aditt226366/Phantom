import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "AI Messaging" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="AI Messaging" />
      <EmptyState
        tone="mint"
        title="No campaigns yet"
        description="A campaign sends an approved template to your leads, then lets Verse answer their replies from your knowledge base."
          action={<Button>Create campaign</Button>}
      />
    </SectionShell>
  );
}
