import type { Metadata } from "next";
import Link from "next/link";
import { CsrfField } from "@/components/ui/csrf-field";
import { SignInForm } from "../_components/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/** Single narrow column — sign-in asks for two things. */
export default function SignInPage() {
  return (
    <div className="w-full max-w-md rounded-xl border border-hairline bg-surface-card p-xl shadow-soft-drop">
      <h1 className="text-display-sm text-ink">Sign in</h1>
      <p className="mb-lg mt-xs text-body-sm text-muted">
        New here?{" "}
        <Link href="/sign-up" className="text-ink underline underline-offset-4">
          Create an account
        </Link>
        .
      </p>

      <SignInForm csrf={<CsrfField />} />
    </div>
  );
}
