import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Template Messaging" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="Template Messaging" />
      <EmptyState
        tone="peach"
        title="No templates yet"
        description="Meta approves every message template before it can be sent. Drafting one here submits it for review, which usually takes a few hours."
          action={<Button>New template</Button>}
      />
    </SectionShell>
  );
}
