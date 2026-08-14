import type { Metadata } from "next";
import { listCompanies, writeAdminAudit } from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { AdminCsrfField } from "./_components/admin-csrf-field";
import { AdminResetForm } from "./_components/admin-reset-form";
import { adminSignOutAction } from "./actions";

export const metadata: Metadata = { title: "Platform admin" };

/**
 * Minimal by intent.
 *
 * This commit is authentication plus enough surface to prove the admin client
 * and its policies work end to end. The Overview and Companies screens are
 * Phase 2.
 */
export default async function AdminHomePage() {
  const session = await requireAdminSession();
  const context = await requestContext();

  const companies = await listCompanies();

  /* Reads are audited too — "which tenants did this operator open" is the
     question an incident review actually needs answered. */
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.companies.list",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { count: companies.length },
  });

  return (
    <main className="mx-auto max-w-container px-lg py-xxl">
      <header className="mb-lg flex items-center justify-between gap-base">
        <div>
          <h1 className="text-display-md text-ink">Platform admin</h1>
          <p className="mt-xxs text-body-sm text-muted">
            Signed in as {session.username}
          </p>
        </div>

        <form action={adminSignOutAction}>
          <AdminCsrfField />
          <button
            type="submit"
            className="rounded-pill border border-hairline-strong px-base py-xs font-body text-button text-ink"
          >
            Log out
          </button>
        </form>
      </header>

      <section className="mb-lg rounded-xl border border-hairline bg-surface-card p-lg">
        <h2 className="text-title-md text-ink">Send a password reset</h2>
        <p className="mb-base mt-xxs max-w-2xl text-body-sm text-muted">
          The link goes to the address on file. It is never shown here, and this
          panel cannot set a password — an operator who could do either could
          take an account without the owner noticing. Sessions are revoked
          straight away.
        </p>
        <AdminResetForm csrf={<AdminCsrfField />} />
      </section>

      <div className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
        <table className="w-full text-left">
          <thead className="border-b border-hairline">
            <tr>
              <th className="px-lg py-sm text-caption-uppercase uppercase text-muted">
                Company
              </th>
              <th className="px-lg py-sm text-caption-uppercase uppercase text-muted">
                Slug
              </th>
              <th className="px-lg py-sm text-caption-uppercase uppercase text-muted">
                Users
              </th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-lg py-xl text-body-sm text-muted">
                  No companies yet.
                </td>
              </tr>
            ) : (
              companies.map((company) => (
                <tr key={company.id} className="border-b border-hairline last:border-0">
                  <td className="px-lg py-sm text-body-sm text-ink">
                    {company.name}
                  </td>
                  <td className="px-lg py-sm text-body-sm text-muted">
                    {company.slug}
                  </td>
                  <td className="px-lg py-sm text-body-sm text-body">
                    {company.userCount}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
