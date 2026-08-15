import { notFound } from "next/navigation";
import { getCompanyDetail } from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { CompanyHeader } from "../../../_components/company-header";
import { CompanyTabs } from "../../../_components/company-tabs";

/**
 * The per-company workspace: one header, four tabs.
 *
 * Chrome only. The guard here is UX — CLAUDE.md rule 4 — and every page under
 * it calls requireAdminSession() for itself, because a layout is cached per
 * segment and is not guaranteed to re-run on navigation between the tabs.
 *
 * An unknown id is a 404 rather than a 403. Rule 6: a 403 confirms the row
 * exists, and there is no reason for this panel to be an existence oracle for
 * company ids.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireAdminSession();

  const { id } = await params;
  const company = await getCompanyDetail(id);

  if (!company) notFound();

  return (
    <div className="flex flex-col gap-lg">
      <CompanyHeader company={company} />
      <CompanyTabs companyId={company.id} />
      {children}
    </div>
  );
}
