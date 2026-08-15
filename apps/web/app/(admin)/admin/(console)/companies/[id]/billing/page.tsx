import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { requireAdminSession } from "@/lib/auth/admin-session";

export const metadata: Metadata = { title: "Billing" };

/**
 * A stub, but not an empty one: usage_events is already recording, so the
 * data this tab will read exists from today rather than from whenever Billing
 * is built.
 */
export default async function CompanyBillingPage() {
  await requireAdminSession();

  return (
    <EmptyState
      title="Billing is not built yet"
      description="Usage is already being recorded against this company, priced at the moment it happens — so this tab will have history to show when it arrives rather than starting from zero."
      tone="peach"
    />
  );
}
