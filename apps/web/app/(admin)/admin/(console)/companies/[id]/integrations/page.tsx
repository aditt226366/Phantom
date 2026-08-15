import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { getCompanyDetail } from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Placeholder for the credential cards, which land in the next commit.
 *
 * The vault behind this tab already works — saving, sealing, masking and
 * verification are all built and tested. What is missing is only the rendering.
 */
export default async function CompanyIntegrationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminSession();

  const { id } = await params;
  if (!(await getCompanyDetail(id))) notFound();

  return (
    <EmptyState
      title="Integration cards land next"
      description="Google Sheets, WhatsApp Cloud and Meta Ads credentials, each with Save, Test Connection and a verification history."
      tone="sky"
    />
  );
}
