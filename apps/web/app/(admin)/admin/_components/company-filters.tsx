import { COMPANY_STATUS_FILTERS, type CompanyStatusFilter } from "@whatsapp-os/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Search and status, as a GET form.
 *
 * A form rather than a client component with state: submitting writes the
 * query string, which is where this page's filter state lives. That buys the
 * back button, a bookmarkable view and a link an operator can paste into a
 * support thread — none of which component state gives, and all of which
 * somebody expects.
 *
 * It also means no JavaScript is required to filter a list of customers, and
 * the page stays a server component running one real query.
 *
 * `cursor` is deliberately not a field here. Submitting a new search drops it,
 * which is right: page three of the previous search is meaningless once the
 * search changes.
 */

const STATUS_LABELS: Record<CompanyStatusFilter, string> = {
  all: "All statuses",
  active: "Active",
  deactivated: "Deactivated",
};

export interface CompanyFiltersProps {
  q: string;
  status: CompanyStatusFilter;
}

export function CompanyFilters({ q, status }: CompanyFiltersProps) {
  const isFiltered = q !== "" || status !== "all";

  return (
    <form
      method="get"
      action="/admin/companies"
      className="flex flex-col gap-sm tablet:flex-row tablet:items-center"
      role="search"
    >
      <label className="tablet:flex-1">
        <span className="sr-only">Search companies</span>
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by company, slug or owner"
          autoComplete="off"
        />
      </label>

      <label>
        <span className="sr-only">Filter by status</span>
        <select
          name="status"
          defaultValue={status}
          className="h-input rounded-md border border-hairline-strong bg-surface-card px-sm font-body text-body-sm text-ink"
        >
          {COMPANY_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-xs">
        <Button type="submit" variant="outline">
          Search
        </Button>

        {isFiltered ? (
          <Button asChild variant="ghost">
            <a href="/admin/companies">Clear</a>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
