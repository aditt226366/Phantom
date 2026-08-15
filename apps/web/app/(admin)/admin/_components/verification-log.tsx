import Link from "next/link";
import { INTEGRATION_LABELS } from "@whatsapp-os/core";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { VerificationPage } from "@/lib/admin-db";
import { formatTimestamp } from "@/lib/format";

/**
 * Verification history.
 *
 * Paged, because nothing prunes this table: one row per check per integration,
 * and an unbounded read would grow forever against the busiest table in the
 * workspace.
 *
 * Same rule as the debug panel — every field here was scrubbed before it was
 * stored, and nothing on this page decrypts anything.
 */
export function VerificationLog({
  companyId,
  page,
}: {
  companyId: string;
  page: VerificationPage;
}) {
  if (page.entries.length === 0) {
    return (
      <EmptyState
        title="No checks yet"
        description="Every Save & Verify and Test Connection is recorded here, with what the provider said."
        tone="sky"
      />
    );
  }

  return (
    <div className="flex flex-col gap-base">
      <div className="overflow-x-auto rounded-xl border border-hairline bg-surface-card">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline">
              <Th>When</Th>
              <Th>Provider</Th>
              <Th>Result</Th>
              <Th>Status</Th>
              <Th>Message</Th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((entry) => (
              <tr key={entry.id} className="border-b border-hairline-soft">
                <Td>{formatTimestamp(entry.createdAt)}</Td>
                <Td>{INTEGRATION_LABELS[entry.provider]}</Td>
                <Td>
                  <Badge variant={entry.ok ? "success" : "error"}>
                    {entry.ok ? "ok" : (entry.failureKind ?? "failed")}
                  </Badge>
                </Td>
                <Td>{entry.statusCode ?? "—"}</Td>
                <Td className="max-w-narrow break-words">{entry.error ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {page.nextCursor ? (
        <Link
          href={`/admin/companies/${companyId}/integrations?view=logs&cursor=${page.nextCursor}`}
          className="self-start rounded-pill border border-hairline-strong px-base py-xs font-body text-button text-ink transition-colors hover:border-ink"
        >
          Older checks
        </Link>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-base py-sm text-caption-uppercase font-normal text-muted">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-base py-sm text-body-sm text-body ${className}`}>
      {children}
    </td>
  );
}
