import type { Metadata } from "next";
import Link from "next/link";
import { companyFilterSchema, safeParseInput } from "@whatsapp-os/core";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { listCompanies, writeAdminAudit } from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { CompanyCard } from "../../_components/company-card";
import { CompanyFilters } from "../../_components/company-filters";

export const metadata: Metadata = { title: "Companies" };

/**
 * Every tenant, filtered in the database.
 *
 * Filter state comes from the URL rather than component state, so this stays a
 * server component running one real query. The alternative — fetch every
 * company and filter in the browser — ships the entire customer list to the
 * client and stops working at the scale where it starts to matter.
 *
 * There is no Create Company button. Companies come from signup, and a panel
 * that could mint one would be a second, unaudited path into a tenant.
 */
export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminSession();
  const context = await requestContext();

  const params = await searchParams;

  /*
   * Parsed, not trusted. A hand-edited limit=100000 would otherwise be a
   * request for every tenant on the installation in one response.
   */
  const parsed = safeParseInput(companyFilterSchema, {
    ...(typeof params["q"] === "string" ? { q: params["q"] } : {}),
    ...(typeof params["status"] === "string" ? { status: params["status"] } : {}),
    ...(typeof params["cursor"] === "string" ? { cursor: params["cursor"] } : {}),
    ...(typeof params["limit"] === "string" ? { limit: params["limit"] } : {}),
  });

  /* A malformed query string falls back to the unfiltered view. */
  const filter = parsed.ok ? parsed.data : { status: "all" as const, limit: 25 };

  const { companies, nextCursor, filtered } = await listCompanies(filter);

  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.companies.list",
    ...(context.ip ? { ip: context.ip } : {}),
    /* What was searched for, never what came back. */
    metadata: { count: companies.length, filtered },
  });

  const q = filter.q ?? "";

  return (
    <div className="flex flex-col gap-lg">
      <header>
        <h1 className="font-display text-display-lg text-ink">Companies</h1>
        <p className="mt-xxs max-w-2xl text-body-sm text-muted">
          Open a company to manage its overview, integrations and billing in a
          single workspace.
        </p>
      </header>

      <CompanyFilters q={q} status={filter.status} />

      {companies.length === 0 ? (
        <CompaniesEmptyState filtered={filtered} />
      ) : (
        <>
          <ul className="grid list-none gap-base tablet:grid-cols-2 desktop:grid-cols-3">
            {companies.map((company) => (
              /* min-w-0, because a grid item's automatic minimum size is its
                 min-content width and `truncate` does not reduce that — it
                 sets white-space: nowrap, so the card's floor was the untruncated
                 company name plus two badges. At 390 that pushed the whole page
                 57px wide and every card past the edge of the screen. */
              <li key={company.id} className="min-w-0">
                <CompanyCard company={company} />
              </li>
            ))}
          </ul>

          {nextCursor ? (
            <Link
              href={`/admin/companies?${new URLSearchParams({
                ...(q ? { q } : {}),
                ...(filter.status !== "all" ? { status: filter.status } : {}),
                cursor: nextCursor,
              }).toString()}`}
              className="self-start rounded-pill border border-hairline-strong px-base py-xs font-body text-button text-ink transition-colors hover:border-ink"
            >
              Load more
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Two states, not one.
 *
 * "Nothing here" and "nothing matched" are different facts and need different
 * responses. Collapsing them tells an operator whose filter happens to exclude
 * everything that the platform has no customers — which is alarming, wrong,
 * and offers them no way out, because the thing to do is clear the filter and
 * the merged message does not mention one.
 */
function CompaniesEmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <EmptyState
        title="No companies match that search"
        description="Try a different name, slug or owner username, or clear the filters to see every company."
        action={
          <Button asChild>
            <Link href="/admin/companies">Clear filters</Link>
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      title="No companies yet"
      description="Companies appear here when someone signs up. There is nothing to create — this panel never mints a tenant."
    />
  );
}
