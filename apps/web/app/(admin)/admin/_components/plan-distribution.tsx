import type { Plan } from "@whatsapp-os/db";
import { Card } from "@/components/ui/card";
import { formatCount } from "@/lib/format";

/**
 * How many companies are on each plan.
 *
 * Bars rather than a second ring: three categories read faster side by side
 * than as arcs, and comparing lengths is easier than comparing angles.
 *
 * Every plan is listed whether or not anybody is on it. A distribution that
 * silently omits empty categories is one where "we have no Enterprise
 * customers" and "Enterprise does not exist" look identical.
 */

/** Declared here so the panel's order is the plan ladder, not alphabetical. */
const PLAN_ORDER: readonly Plan[] = ["STARTER", "PRO", "ENTERPRISE"];

const PLAN_LABELS: Record<Plan, string> = {
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
};

export interface PlanDistributionProps {
  distribution: ReadonlyArray<{ plan: Plan; count: number }>;
}

export function PlanDistribution({ distribution }: PlanDistributionProps) {
  const counts = new Map(distribution.map((row) => [row.plan, row.count]));
  const total = distribution.reduce((sum, row) => sum + row.count, 0);

  return (
    <Card className="flex flex-col gap-base">
      <p className="text-caption-uppercase text-muted">Plan distribution</p>

      <dl className="flex flex-col gap-sm">
        {PLAN_ORDER.map((plan) => {
          const count = counts.get(plan) ?? 0;
          /* Zero total is a fresh install, not a divide. */
          const share = total === 0 ? 0 : (count / total) * 100;

          return (
            <div key={plan} className="flex flex-col gap-xxs">
              <div className="flex items-baseline justify-between gap-xs">
                <dt className="text-body-sm text-body">{PLAN_LABELS[plan]}</dt>
                <dd className="text-body-strong text-ink">
                  {formatCount(count)}
                </dd>
              </div>

              <div
                className="h-xxs overflow-hidden rounded-pill bg-hairline"
                role="img"
                aria-label={`${PLAN_LABELS[plan]}: ${count} of ${total}`}
              >
                <div
                  className="h-full rounded-pill bg-ink"
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          );
        })}
      </dl>

      {total === 0 ? (
        <p className="text-caption text-muted">
          No companies yet, so every plan is empty.
        </p>
      ) : null}
    </Card>
  );
}
