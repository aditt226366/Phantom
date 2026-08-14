import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../_components/section";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage() {
  await requireSession();

  return (
    <SectionShell>
      <SectionHeader title="Documents" />
      <EmptyState
        tone="peach"
        title="No documents yet"
        description="Business verification documents and signed agreements will be kept here."
      />
    </SectionShell>
  );
}
