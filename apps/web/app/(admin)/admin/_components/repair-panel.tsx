import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { RepairRun } from "@/lib/admin-db";
import { formatTimestampWithZone } from "@/lib/format";
import { AdminCsrfField } from "./admin-csrf-field";
import { repairIntegrationsAction } from "../actions";

/**
 * Repair Integration DB.
 *
 * Platform-wide rather than per-company, so it lives on the platform page. The
 * brief listed it beside the integrations tab, but a control that re-verifies
 * every tenant sitting inside one tenant's workspace reads as though it acts
 * on that tenant.
 *
 * The run summary is the point. The operator asked a question about the whole
 * installation, and per-integration timestamps cannot answer it — they say
 * which rows are newer, not whether the run finished. Progress is derived from
 * verifications newer than the run's start, so it cannot drift from what
 * actually happened.
 */
export function RepairPanel({ run }: { run: RepairRun | null }) {
  const done = run !== null && run.completedCompanies >= run.totalCompanies;

  return (
    <Card className="flex flex-col gap-sm">
      <h2 className="text-title-md text-ink">Repair integration DB</h2>

      <p className="max-w-2xl text-body-sm text-muted">
        Re-verifies every integration on the installation against its provider
        and records what came back. Each company is checked in its own job, so
        one broken tenant does not stop the rest.
      </p>

      {run ? (
        <p className="text-body-sm text-body">
          Last run started {formatTimestampWithZone(run.startedAt)} ·{" "}
          {run.completedCompanies} of {run.totalCompanies}{" "}
          {run.totalCompanies === 1 ? "company" : "companies"}{" "}
          {done ? "done" : "checked so far"}
        </p>
      ) : (
        <p className="text-body-sm text-muted">Never run.</p>
      )}

      <form action={repairIntegrationsAction} className="self-start">
        <AdminCsrfField />
        <Button type="submit" variant="outline">
          Run repair
        </Button>
      </form>
    </Card>
  );
}
