import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CompanyDetail } from "@/lib/admin-db";
import { formatTimestamp } from "@/lib/format";
import { AdminCsrfField } from "./admin-csrf-field";
import { AdminResetForm } from "./admin-reset-form";
import {
  deactivateCompanyAction,
  reactivateCompanyAction,
} from "../actions";

/**
 * The company workspace header.
 *
 * Deactivate and Reactivate are links to a confirmation page, not the act
 * itself — see the actions module for why the act cannot be a GET. Which one
 * appears is decided by the company's current state, so there is always a way
 * back from a misclick.
 *
 * Reset Password is disabled while the company is deactivated, with the reason
 * on the page rather than in a tooltip. app_resolve_company() refuses the
 * 'password_reset' kind for a suspended company, so the link would arrive and
 * fail to resolve, and the operator would go looking at the mail server.
 */

/**
 * Which way the deactivation control points.
 *
 * Extracted so both branches can be asserted directly. Left inline it was a
 * ternary inside JSX, and the only available test was "the file mentions
 * Reactivate somewhere" — which stayed green when the control was removed and
 * the word survived in a neighbouring heading.
 */
export function deactivationControl(status: CompanyDetail["status"]): {
  intent: "deactivate" | "reactivate";
  label: string;
  submitLabel: string;
} {
  return status === "DEACTIVATED"
    ? {
        intent: "reactivate",
        label: "Reactivate",
        submitLabel: "Reactivate company",
      }
    : {
        intent: "deactivate",
        label: "Deactivate",
        submitLabel: "Deactivate company",
      };
}

const PLAN_LABELS = {
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
} as const;

export function CompanyHeader({ company }: { company: CompanyDetail }) {
  const deactivated = company.status === "DEACTIVATED";
  const control = deactivationControl(company.status);

  return (
    <header className="flex flex-col gap-base">
      <Link
        href="/admin/companies"
        className="text-caption text-muted transition-colors hover:text-ink"
      >
        ← All companies
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-base">
        <div className="min-w-0">
          <h1 className="font-display text-display-lg text-ink">
            {company.name}
          </h1>
          <p className="mt-xxs text-body-sm text-muted">
            {company.ownerUsername ?? "No owner"} · Last login{" "}
            {formatTimestamp(company.ownerLastLoginAt)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          <Badge variant="outline">{PLAN_LABELS[company.plan]}</Badge>
          <Badge variant={deactivated ? "error" : "default"}>
            {deactivated ? "Deactivated" : "Active"}
          </Badge>

          <Button asChild variant="outline" size="sm">
            <Link
              href={`/admin/companies/${company.id}?confirm=${control.intent}`}
            >
              {control.label}
            </Link>
          </Button>
        </div>
      </div>

      <section className="rounded-xl border border-hairline bg-surface-card p-lg">
        <h2 className="text-title-sm text-ink">Send a password reset</h2>

        {deactivated ? (
          <p className="mt-xxs max-w-2xl text-body-sm text-muted">
            Unavailable while this company is deactivated. A reset link cannot
            be used by a suspended workspace — the link would arrive and fail
            to resolve. Reactivate the company first.
          </p>
        ) : (
          <>
            <p className="mb-base mt-xxs max-w-2xl text-body-sm text-muted">
              The link goes to the address on file. It is never shown here, and
              this panel cannot set a password. Every signed-in device is
              signed out straight away.
            </p>

            <AdminResetForm
              csrf={<AdminCsrfField />}
              defaultUsername={company.ownerUsername ?? ""}
            />
          </>
        )}
      </section>
    </header>
  );
}

/** The confirmation step. A GET renders this; only the form below mutates. */
export function DeactivationConfirm({
  company,
  intent,
}: {
  company: CompanyDetail;
  intent: "deactivate" | "reactivate";
}) {
  const deactivating = intent === "deactivate";
  const control = deactivationControl(
    deactivating ? "ACTIVE" : "DEACTIVATED",
  );

  return (
    <section className="rounded-xl border border-hairline-strong bg-surface-card p-lg">
      <h2 className="font-display text-display-sm text-ink">
        {deactivating ? "Deactivate" : "Reactivate"} {company.name}?
      </h2>

      {/*
        The company and the owner are named, and the consequences are spelled
        out. "Are you sure?" with no name is how the wrong company gets
        suspended at six in the evening.
      */}
      <div className="mt-sm flex max-w-2xl flex-col gap-xs text-body-sm text-body">
        <p>
          Owner: <span className="text-ink">{company.ownerUsername ?? "none"}</span>
          {" · "}
          {company.userCount} user{company.userCount === 1 ? "" : "s"}
        </p>

        {deactivating ? (
          <>
            <p>Sign-in will refuse for everyone in this company.</p>
            <p>
              Anyone currently signed in stops working on their next request —
              not when their session expires.
            </p>
            <p>Password reset and email verification links stop resolving.</p>
          </>
        ) : (
          <p>
            Sign-in will start working again. Sessions that were open before
            deactivation do not come back; those people sign in again.
          </p>
        )}
      </div>

      <div className="mt-lg flex items-center gap-sm">
        <form
          action={
            deactivating ? deactivateCompanyAction : reactivateCompanyAction
          }
        >
          <AdminCsrfField />
          <input type="hidden" name="companyId" defaultValue={company.id} />
          <Button type="submit">{control.submitLabel}</Button>
        </form>

        <Button asChild variant="ghost">
          <Link href={`/admin/companies/${company.id}`}>Cancel</Link>
        </Button>
      </div>
    </section>
  );
}
