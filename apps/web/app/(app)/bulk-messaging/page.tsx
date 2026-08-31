import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Bulk Messaging" };

export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="Bulk Messaging" />
      <EmptyState
        tone="lavender"
        title="Nothing sent yet"
        description={EMPTY_COPY["bulk-messaging"]}
          action={<Button>Import contacts</Button>}
      />
    </SectionShell>
  );
}
