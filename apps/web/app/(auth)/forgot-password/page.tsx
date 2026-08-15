import type { Metadata } from "next";
import Link from "next/link";
import { CsrfField } from "@/components/ui/csrf-field";
import { ForgotPasswordForm } from "../_components/forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;

  /*
   * One page for both outcomes. Whether the address belongs to anyone is not
   * disclosed — with no password to guess and no lockout to hit, a "no such
   * account" message would make this a membership oracle for any address.
   */
  if (sent) {
    return (
      <div className="w-full max-w-narrow rounded-xl border border-hairline bg-surface-card p-xl text-center shadow-soft-drop">
        <h1 className="text-display-sm text-ink">Check your email</h1>
        <p className="mt-sm text-body-sm text-body">
          If that address belongs to an account, a reset link is on its way. It
          expires in one hour and can be used once.
        </p>
        <p className="mt-base text-caption text-muted">
          In development the link is written to the server log rather than sent.
        </p>
        <p className="mt-lg text-body-sm text-muted">
          <Link href="/sign-in" className="text-ink underline underline-offset-4">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-narrow rounded-xl border border-hairline bg-surface-card p-xl shadow-soft-drop">
      <h1 className="text-display-sm text-ink">Reset your password</h1>
      <p className="mb-lg mt-xs text-body-sm text-muted">
        We will email you a link.{" "}
        <Link href="/sign-in" className="text-ink underline underline-offset-4">
          Back to sign in
        </Link>
        .
      </p>

      <ForgotPasswordForm csrf={<CsrfField />} />
    </div>
  );
}
