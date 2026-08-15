import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  INTEGRATION_LABELS,
  INTEGRATION_PROVIDERS,
  type IntegrationProviderName,
} from "@whatsapp-os/core";
import { Button } from "@/components/ui/button";
import {
  getCompanyDetail,
  listIntegrations,
  listVerifications,
  writeAdminAudit,
} from "@/lib/admin-db";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { AdminCsrfField } from "../../../../_components/admin-csrf-field";
import { IntegrationCard } from "../../../../_components/integration-card";
import { VerificationLog } from "../../../../_components/verification-log";
import { disconnectIntegrationAction } from "../../../../actions";

export const metadata: Metadata = { title: "Integrations" };

/**
 * The credential cards, and the history of what the providers said.
 *
 * Three separate forms, one per provider — not one form for the tab. Under
 * "blank means unchanged" a single form would resubmit two providers' blank
 * fields on every save, and Save & Verify would have to guess which provider
 * the operator meant.
 */
export default async function CompanyIntegrationsPage({
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
  if (!company) notFound();

  const query = await searchParams;
  const view = query["view"] === "logs" ? "logs" : "credentials";

  const [integrations, logs] = await Promise.all([
    listIntegrations(company.id),
    listVerifications(company.id, {
      ...(typeof query["cursor"] === "string" ? { cursor: query["cursor"] } : {}),
    }),
  ]);

  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.integrations.view",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { companyId: company.id, view },
  });

  const byProvider = new Map(
    integrations.map((integration) => [integration.provider, integration]),
  );

  /* The newest check per provider, for each card's debug panel. */
  const latestByProvider = new Map<IntegrationProviderName, (typeof logs.entries)[number]>();
  for (const entry of logs.entries) {
    if (!latestByProvider.has(entry.provider)) {
      latestByProvider.set(entry.provider, entry);
    }
  }

  const confirmProvider =
    query["confirm"] === "disconnect" &&
    typeof query["provider"] === "string" &&
    (INTEGRATION_PROVIDERS as readonly string[]).includes(query["provider"])
      ? (query["provider"] as IntegrationProviderName)
      : null;

  return (
    <div className="flex flex-col gap-lg">
      {confirmProvider ? (
        <DisconnectConfirm
          companyId={company.id}
          companyName={company.name}
          provider={confirmProvider}
        />
      ) : null}

      <nav aria-label="Integration views" className="flex items-center gap-base">
        <SubTab
          href={`/admin/companies/${company.id}/integrations`}
          active={view === "credentials"}
        >
          Credentials
        </SubTab>
        <SubTab
          href={`/admin/companies/${company.id}/integrations?view=logs`}
          active={view === "logs"}
        >
          Verification logs
        </SubTab>
      </nav>

      {view === "logs" ? (
        <VerificationLog companyId={company.id} page={logs} />
      ) : (
        <div className="grid gap-base desktop:grid-cols-2">
          {INTEGRATION_PROVIDERS.map((provider) => (
            <IntegrationCard
              key={provider}
              companyId={company.id}
              provider={provider}
              integration={byProvider.get(provider)}
              latest={latestByProvider.get(provider)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`text-nav-link transition-colors ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * The disconnect confirmation.
 *
 * A GET renders this; the form below is the POST that acts. Named, because
 * this deletes credentials that cannot be read back — re-connecting means
 * fetching every value again from the provider's own console.
 */
function DisconnectConfirm({
  companyId,
  companyName,
  provider,
}: {
  companyId: string;
  companyName: string;
  provider: IntegrationProviderName;
}) {
  return (
    <section className="rounded-xl border border-hairline-strong bg-surface-card p-lg">
      <h2 className="font-display text-display-sm text-ink">
        Disconnect {INTEGRATION_LABELS[provider]} for {companyName}?
      </h2>

      <div className="mt-sm flex max-w-2xl flex-col gap-xs text-body-sm text-body">
        <p>
          The stored credentials are deleted, not just marked disconnected.
          Nothing here can read them back, so re-connecting means entering
          every value again from {INTEGRATION_LABELS[provider]}.
        </p>
        <p>
          The verification history is kept, so you can still see that this was
          once connected and what it said when it stopped.
        </p>
      </div>

      <div className="mt-lg flex items-center gap-sm">
        <form action={disconnectIntegrationAction}>
          <AdminCsrfField />
          <input type="hidden" name="companyId" defaultValue={companyId} />
          <input type="hidden" name="provider" defaultValue={provider} />
          <Button type="submit">Delete credentials</Button>
        </form>

        <Button asChild variant="ghost">
          <Link href={`/admin/companies/${companyId}/integrations`}>Cancel</Link>
        </Button>
      </div>
    </section>
  );
}
