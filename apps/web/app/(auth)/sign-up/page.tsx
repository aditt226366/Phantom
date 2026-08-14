import type { Metadata } from "next";
import Link from "next/link";
import { CsrfField } from "@/components/ui/csrf-field";
import { SignUpForm } from "../_components/sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

/**
 * Two columns at desktop: the form, and a panel carrying the brand.
 *
 * Server component. CsrfField is rendered here and passed into the client form
 * as a child, which is what lets the form stay interactive without needing to
 * read cookies itself.
 */
export default function SignUpPage() {
  return (
    <div className="grid w-full grid-cols-1 gap-xxl desktop:grid-cols-[1fr_minmax(0,520px)] desktop:items-center">
      <aside className="hidden flex-col gap-base desktop:flex">
        <p className="text-caption-uppercase uppercase text-muted">
          whatsapp-os
        </p>
        <h1 className="text-display-xl text-ink">
          One workspace for every conversation.
        </h1>
        <p className="max-w-md text-body-md text-body">
          Templates, campaigns and replies in one place — with the isolation
          guarantees that let you put real customer data in it.
        </p>
      </aside>

      <div className="rounded-xl border border-hairline bg-surface-card p-xl shadow-soft-drop">
        <h2 className="text-display-sm text-ink">Create an account</h2>
        <p className="mb-lg mt-xs text-body-sm text-muted">
          Already have one?{" "}
          <Link href="/sign-in" className="text-ink underline underline-offset-4">
            Sign in
          </Link>
          .
        </p>

        <SignUpForm csrf={<CsrfField />} />
      </div>
    </div>
  );
}
