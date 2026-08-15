import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { requireAdminSession } from "@/lib/auth/admin-session";

export const metadata: Metadata = { title: "Documents" };

/** A stub with an honest label. Documents are Phase 3. */
export default async function CompanyDocumentsPage() {
  await requireAdminSession();

  return (
    <EmptyState
      title="Documents arrive in Phase 3"
      description="This tab will hold the files a company has uploaded and what the system extracted from them. Nothing is stored yet, so there is nothing to show — this is a placeholder, not an empty folder."
      tone="lavender"
    />
  );
}
