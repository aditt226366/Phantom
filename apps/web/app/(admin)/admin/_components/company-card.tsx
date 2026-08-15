import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatTimestamp } from "@/lib/format";
import type { CompanySummary } from "@/lib/admin-db";

/**
 * One tenant.
 *
 * "Open workspace" is a plain link into the admin's own per-company view —
 * /admin/companies/:id, which is the Overview / Integrations / Documents /
 * Billing workspace. It mints nothing and crosses no boundary; the phrase
 * carries no impersonation meaning here.
 *
 * Status is quiet when normal and flagged when not: an outline badge for
 * Active, the error tone for Deactivated. Green is reserved for semantic
 * success elsewhere in the system and an ordinary running workspace is not an
 * achievement worth colouring.
 */

const PLAN_LABELS = {
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
} as const;

export function CompanyCard({ company }: { company: CompanySummary }) {
  return (
    <Card className="flex flex-col gap-base">
      <div className="flex items-start justify-between gap-base">
        <div className="min-w-0">
          <h2 className="truncate font-display text-title-md text-ink">
            {company.name}
          </h2>
          <p className="mt-xxs truncate text-body-sm text-muted">
            {company.ownerUsername ?? "No owner"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-xs">
          <Badge variant="outline">{PLAN_LABELS[company.plan]}</Badge>
          <Badge variant={company.status === "ACTIVE" ? "default" : "error"}>
            {company.status === "ACTIVE" ? "Active" : "Deactivated"}
          </Badge>
        </div>
      </div>

      <dl className="flex items-baseline gap-xs">
        <dt className="text-caption text-muted">Last login</dt>
        <dd className="text-body-sm text-body">
          {formatTimestamp(company.ownerLastLoginAt)}
        </dd>
      </dl>

      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/admin/companies/${company.id}`}>Open workspace</Link>
      </Button>
    </Card>
  );
}
