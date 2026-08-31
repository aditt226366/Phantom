import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { getCompanyDetail, writeAdminAudit } from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { formatCount, formatTimestamp } from "@/lib/format";
import { DeactivationConfirm } from "../../../_components/company-header";
import { AdminCsrfField } from "../../../_components/admin-csrf-field";
import { Button } from "@/components/ui/button";
import {
  MAX_BROADCAST_GAP_MS,
  MIN_BROADCAST_GAP_MS,
} from "@/lib/admin-db";
import { setBroadcastGapAction } from "../../../actions";

export const metadata: Metadata = { title: "Company overview" };

/**
 * The company's Overview tab, and the host for the deactivation confirmation.
 *
 * The confirmation is rendered here on a GET — safe, idempotent, and nothing
 * more than a page. The act itself is a POST from the form inside it. A URL
 * that deactivated on GET would be reachable by a browser preloading a hovered
 * link and by any scanner that follows one out of an alert email, and the
 * consequence is a paying customer losing access.
 */
export default async function CompanyOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminSession();
  const context = await requestContext();

  const { id } = await params;
  const company = await getCompanyDetail(id);

  /* Rule 6: if it is not there, it does not exist. Never a 403. */
  if (!company) notFound();

  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.company.view",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { companyId: company.id },
  });

  const confirm = (await searchParams)["confirm"];
  const intent =
    confirm === "deactivate" || confirm === "reactivate" ? confirm : null;

  return (
    <div className="flex flex-col gap-lg">
      {intent ? (
        <DeactivationConfirm company={company} intent={intent} />
      ) : null}

      <section
        aria-label="Company facts"
        className="grid gap-base tablet:grid-cols-2 desktop:grid-cols-3"
      >
        <Fact label="Workspace handle" value={company.slug} />
        <Fact label="Users" value={formatCount(company.userCount)} />
        <Fact label="Created" value={formatTimestamp(company.createdAt)} />
        <Fact
          label="Owner last login"
          value={formatTimestamp(company.ownerLastLoginAt)}
        />
        {company.deactivatedAt ? (
          <Fact
            label="Deactivated"
            value={formatTimestamp(company.deactivatedAt)}
          />
        ) : null}
      </section>

      {/*
        Pacing, and NOT the limit.

        The messaging tier caps unique recipients per rolling 24 hours and no
        gap gets past it; this only changes how quickly a run works through
        what it is allowed. It is an operator's control rather than a tenant's
        because it is a judgement about how hard to push a number against its
        quality rating, and the consequence of getting that wrong lands on the
        platform's standing with Meta.
      */}
      <section aria-label="Broadcast pacing">
        <Card className="flex flex-col gap-sm">
          <div>
            <p className="text-caption-uppercase text-muted">Broadcast pacing</p>
            <p className="mt-xxs text-body-sm text-body">
              Milliseconds between two sends of one broadcast. Lower is faster
              and pushes the number harder; it does not raise the messaging
              tier, which is the real ceiling. A broadcast already running keeps
              the pace it started with.
            </p>
          </div>

          <form
            action={setBroadcastGapAction}
            className="flex flex-wrap items-end gap-sm"
          >
            <AdminCsrfField />
            <input type="hidden" name="companyId" defaultValue={company.id} />

            <div className="flex flex-col gap-xxs">
              <label
                htmlFor="broadcast-gap"
                className="text-caption-uppercase text-muted"
              >
                Gap in milliseconds
              </label>
              <input
                id="broadcast-gap"
                name="gapMs"
                type="number"
                min={MIN_BROADCAST_GAP_MS}
                max={MAX_BROADCAST_GAP_MS}
                step={50}
                defaultValue={company.broadcastGapMs}
                className="max-w-narrow rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
              />
            </div>

            <Button type="submit" variant="outline" size="sm">
              Save pacing
            </Button>
          </form>
        </Card>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex flex-col gap-xxs">
      <p className="text-caption-uppercase text-muted">{label}</p>
      <p className="break-words text-body-strong text-ink">{value}</p>
    </Card>
  );
}
