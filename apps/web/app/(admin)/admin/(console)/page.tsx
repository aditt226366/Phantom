import type { Metadata } from "next";
import { PLATFORM_TIMEZONE_LABEL } from "@whatsapp-os/core";
import {
  getPlatformOverview,
  latestRepairRun,
  writeAdminAudit,
} from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { Card } from "@/components/ui/card";
import { formatCount, formatMicros } from "@/lib/format";
import { PlanDistribution } from "../_components/plan-distribution";
import { RepairPanel } from "../_components/repair-panel";
import { StatCard } from "../_components/stat-card";
import { StatusDonut } from "../_components/status-donut";

export const metadata: Metadata = { title: "Platform analytics" };

/**
 * Platform analytics.
 *
 * Every figure is a live query. Nothing here is a placeholder, because a
 * plausible constant on a dashboard is not discovered until somebody acts on
 * it — and by then they have acted.
 *
 * All of it also has to read correctly against an empty database, which is the
 * state a fresh deployment is actually in and the one that is easiest never to
 * look at.
 */
export default async function AdminOverviewPage() {
  const session = await requireAdminSession();
  const context = await requestContext();

  const [overview, repair] = await Promise.all([
    getPlatformOverview(),
    latestRepairRun(),
  ]);

  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.overview.view",
    ...(context.ip ? { ip: context.ip } : {}),
  });

  return (
    <div className="flex flex-col gap-xl">
      <header>
        <h1 className="font-display text-display-lg text-ink">
          Platform analytics
        </h1>
        <p className="mt-xxs text-body-sm text-muted">
          Live across every company on this installation.
        </p>
      </header>

      <section
        aria-label="Headline figures"
        className="grid gap-base tablet:grid-cols-2 desktop:grid-cols-3"
      >
        <StatCard
          label="Total companies"
          value={formatCount(overview.totalCompanies)}
          caption={
            overview.totalCompanies === 0
              ? "None yet"
              : `${formatCount(overview.activeCompanies)} active · ${formatCount(
                  overview.deactivatedCompanies,
                )} deactivated`
          }
        />

        <StatCard
          label="Total users"
          value={formatCount(overview.totalUsers)}
          caption={overview.totalUsers === 0 ? "None yet" : "Across all companies"}
        />

        <StatCard
          label="API calls today"
          value={formatCount(overview.apiCallsToday)}
          /*
           * The window, stated. Without it the reader supplies their own
           * definition of "today", and at 9am in India a UTC boundary means
           * they are looking at a window that opened the previous afternoon.
           */
          caption={`Since midnight ${PLATFORM_TIMEZONE_LABEL}`}
        />

        <SpendCard
          spend={overview.spendThisMonth}
          unpriced={overview.unpricedThisMonth}
        />

        <StatusDonut
          active={overview.activeCompanies}
          deactivated={overview.deactivatedCompanies}
        />

        <PlanDistribution distribution={overview.planDistribution} />

        <UnroutableCard unroutable={overview.unroutableThisWeek} />
      </section>

      <RepairPanel run={repair} />
    </div>
  );
}

/**
 * Estimated spend, per currency.
 *
 * Never one total. Meta bills in the ad account's currency and the AI
 * providers bill USD, so adding them produces a number with no unit — and it
 * would look exactly as authoritative as a real one.
 */
function SpendCard({
  spend,
  unpriced,
}: {
  spend: ReadonlyArray<{ currency: string; micros: bigint }>;
  unpriced: number;
}) {
  const note =
    unpriced > 0 ? (
      <>
        {formatCount(unpriced)} event{unpriced === 1 ? "" : "s"} this month had
        no price and {unpriced === 1 ? "is" : "are"} not included.
      </>
    ) : undefined;

  if (spend.length === 0) {
    return (
      <StatCard
        label="Est. spend this month"
        value="—"
        caption="Nothing billable recorded yet"
        {...(note ? { note } : {})}
      />
    );
  }

  const [first, ...rest] = spend;

  return (
    <StatCard
      label="Est. spend this month"
      value={formatMicros(first!.micros, first!.currency)}
      caption={
        rest.length === 0
          ? `Since the 1st, ${PLATFORM_TIMEZONE_LABEL}`
          : rest
              .map((entry) => formatMicros(entry.micros, entry.currency))
              .join(" · ")
      }
      {...(note ? { note } : {})}
    />
  );
}

/**
 * Webhook deliveries that arrived and could not be routed.
 *
 * P6: operator visibility is a commit rather than a claim. These rows have
 * existed since 4a and were readable only by querying the table - so a tenant
 * whose webhook was misconfigured was invisible to the person whose job is
 * noticing, and stayed invisible until they complained.
 *
 * Two numbers rather than one, because they are different problems:
 *
 *   Unknown key    the path matches no integration. A rotated key, a stale
 *                  Meta config, or somebody probing. Nothing is arriving.
 *   Bad signature  the key resolves but the signature did not verify. Almost
 *                  always a stale app secret on a REAL tenant, which is a
 *                  support call that has not been made yet.
 *
 * Zero is the expected reading, and it renders as plainly as any other number.
 * A card that hid itself when empty would leave an operator unable to tell "no
 * problems" from "this panel is broken", which is the distinction the card is
 * for.
 */
function UnroutableCard({
  unroutable,
}: {
  unroutable: { unknownKey: number; badSignature: number; attempts: number };
}) {
  const total = unroutable.unknownKey + unroutable.badSignature;

  return (
    /* Card and the same type tokens StatCard uses, so this reads as one of the
       row rather than as something bolted on. `text-caption-uppercase` is a
       type step and not a transform - adding `uppercase` on top shouted the
       label at a reader every neighbouring card speaks to normally. */
    <Card className="flex flex-col gap-xxs">
      <p className="text-caption-uppercase text-muted">Unroutable webhooks</p>

      <p
        className={
          total > 0
            ? "font-display text-display-md text-error"
            : "font-display text-display-md text-ink"
        }
      >
        {formatCount(total)}
      </p>

      <p className="text-caption text-muted">
        {formatCount(unroutable.unknownKey)} unknown key
        {unroutable.unknownKey === 1 ? "" : "s"} ·{" "}
        {formatCount(unroutable.badSignature)} bad signature
        {unroutable.badSignature === 1 ? "" : "s"}
      </p>

      {/* Distinct keys above; deliveries here. The first is how many problems,
          the second is how loudly they are failing. */}
      <p className="mt-xxs text-caption text-muted-soft">
        {formatCount(unroutable.attempts)} deliveries, last 7 days
      </p>
    </Card>
  );
}
