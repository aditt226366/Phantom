import Link from "next/link";
import {
  INTEGRATION_LABELS,
  type IntegrationProviderName,
} from "@whatsapp-os/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { IntegrationView, VerificationEntry } from "@/lib/admin-db";
import { formatTimestamp } from "@/lib/format";
import { AdminCsrfField } from "./admin-csrf-field";
import { IntegrationForm, TestConnectionForm } from "./integration-form";

/**
 * One provider's card.
 *
 * The badge reads from the stored status, which the action has already
 * written by the time this re-renders. Nothing flips optimistically: an
 * integration that says CONNECTED because the browser assumed so is worse
 * than one that takes a second to say NOT_CONNECTED, because the operator
 * acts on the badge.
 */
export function IntegrationCard({
  companyId,
  provider,
  integration,
  latest,
}: {
  companyId: string;
  provider: IntegrationProviderName;
  integration: IntegrationView | undefined;
  /** The most recent verification for this provider, if there is one. */
  latest: VerificationEntry | undefined;
}) {
  const connected = integration?.status === "CONNECTED";
  const stored = integration?.secrets ?? [];

  return (
    <Card className="flex flex-col gap-base">
      <div className="flex items-start justify-between gap-base">
        <div>
          <h3 className="font-display text-title-md text-ink">
            {INTEGRATION_LABELS[provider]}
          </h3>
          <p className="mt-xxs text-caption text-muted">
            Last verified {formatTimestamp(integration?.lastVerifiedAt)}
          </p>
        </div>

        <Badge variant={connected ? "success" : "outline"}>
          {connected ? "CONNECTED" : "NOT CONNECTED"}
        </Badge>
      </div>

      {integration?.lastError ? (
        <p className="rounded-md border border-hairline bg-surface-strong p-sm text-body-sm text-error">
          {integration.lastError}
        </p>
      ) : null}

      <IntegrationForm
        companyId={companyId}
        provider={provider}
        stored={stored.map((secret) => ({
          key: secret.key,
          last4: secret.last4,
        }))}
        csrf={<AdminCsrfField />}
      />

      <div className="flex flex-wrap items-center justify-between gap-xs border-t border-hairline pt-base">
        <TestConnectionForm
          companyId={companyId}
          provider={provider}
          csrf={<AdminCsrfField />}
        />

        {stored.length > 0 ? (
          <Button asChild variant="ghost" size="sm">
            <Link
              href={`/admin/companies/${companyId}/integrations?confirm=disconnect&provider=${provider}`}
            >
              Disconnect
            </Link>
          </Button>
        ) : null}
      </div>

      <DebugDetails entry={latest} />
    </Card>
  );
}

/**
 * Debug details.
 *
 * ---------------------------------------------------------------------------
 * Read this before adding anything to this component
 * ---------------------------------------------------------------------------
 *
 * Everything here comes from a stored IntegrationVerification row, and every
 * one of those was scrubbed before it was written — the adapter passes each
 * message through scrubValues with the credentials it just used, because Meta
 * quotes request parameters back in some error bodies. That scrubbing at write
 * time is the entire reason this panel is safe to render.
 *
 * So it does not decrypt. It does not read integration_secrets. It does not
 * show "just the first six characters so support can eyeball it", and it does
 * not show last4 "for confirmation" — the operator already sees last4 in the
 * form field above, which is the one place it belongs.
 *
 * This is the surface where that convenience gets requested in month three,
 * by somebody debugging a real customer at 6pm with a plausible reason. The
 * answer is no: a panel that can show part of a credential is a panel that
 * has a credential to show, and the whole design above exists to make that
 * false. If more diagnostic detail is needed, add a scrubbed field to the
 * verification row at write time, where the scrubbing lives.
 *
 * Exported so a test can render it directly and assert that no fragment of a
 * stored credential survives into the markup.
 */
export function DebugDetails({
  entry,
}: {
  entry: VerificationEntry | undefined;
}) {
  if (!entry) return null;

  return (
    <details className="rounded-md border border-hairline bg-canvas-soft p-sm">
      <summary className="cursor-pointer text-caption text-muted">
        Debug details
      </summary>

      <dl className="mt-sm flex flex-col gap-xxs text-caption">
        <Row label="Result" value={entry.ok ? "ok" : "failed"} />
        {entry.statusCode !== null ? (
          <Row label="Status" value={String(entry.statusCode)} />
        ) : null}
        {entry.failureKind ? (
          <Row label="Kind" value={entry.failureKind} />
        ) : null}
        <Row label="When" value={formatTimestamp(entry.createdAt)} />
        {entry.error ? <Row label="Message" value={entry.error} /> : null}
        {entry.details ? (
          <Row label="Provider" value={JSON.stringify(entry.details)} />
        ) : null}
      </dl>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-xs">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="break-all text-body">{value}</dd>
    </div>
  );
}
