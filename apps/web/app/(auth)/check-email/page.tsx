import type { Metadata } from "next";

export const metadata: Metadata = { title: "Check your email" };

/** Shown after a resend. Signup itself goes straight to the dashboard. */
export default function CheckEmailPage() {
  return (
    <div className="w-full max-w-md rounded-xl border border-hairline bg-surface-card p-xl text-center shadow-soft-drop">
      <h1 className="text-display-sm text-ink">Check your email</h1>
      <p className="mt-sm text-body-sm text-body">
        We sent a verification link. It expires in 24 hours, and it can only be
        used once.
      </p>
      <p className="mt-base text-caption text-muted">
        In development the link is written to the server log rather than sent.
      </p>
    </div>
  );
}
