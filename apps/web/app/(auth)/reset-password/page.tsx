import type { Metadata } from "next";
import Link from "next/link";
import { CsrfField } from "@/components/ui/csrf-field";
import { inspectResetToken } from "@/lib/auth/password-reset";
import { ResetPasswordForm } from "../_components/forgot-password-form";

export const metadata: Metadata = { title: "Set a new password" };

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  /*
   * Inspected, not consumed. Rendering the form should not spend the token —
   * a preview fetch by a mail client would otherwise burn it before the user
   * ever clicked.
   */
  const lookup = await inspectResetToken(token ?? "");

  if (!lookup.ok) {
    return (
      <div className="w-full max-w-narrow rounded-xl border border-hairline bg-surface-card p-xl text-center shadow-soft-drop">
        <h1 className="text-display-sm text-ink">This link has expired</h1>
        <p className="mt-sm text-body-sm text-body">
          Reset links last one hour and can be used once.
        </p>
        <p className="mt-lg text-body-sm text-muted">
          <Link
            href="/forgot-password"
            className="text-ink underline underline-offset-4"
          >
            Request a new one
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-narrow rounded-xl border border-hairline bg-surface-card p-xl shadow-soft-drop">
      <h1 className="text-display-sm text-ink">Set a new password</h1>
      <p className="mb-lg mt-xs text-body-sm text-muted">
        Every signed-in device will be signed out.
      </p>

      <ResetPasswordForm csrf={<CsrfField />} token={token ?? ""} />
    </div>
  );
}
