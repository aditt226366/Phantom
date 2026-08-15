import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth/safe-next";
import { AdminCsrfField } from "../_components/admin-csrf-field";
import { AdminSignInForm } from "../_components/admin-sign-in-form";

export const metadata: Metadata = { title: "Platform admin" };

/**
 * Deliberately spare. This is not a product surface, and it should not look
 * like one — nothing here hints at what is behind it.
 */
export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-lg py-xxl">
      <div className="w-full max-w-narrow rounded-xl border border-hairline bg-surface-card p-xl">
        <p className="text-caption-uppercase uppercase text-muted">
          whatsapp-os
        </p>
        <h1 className="mb-lg mt-xxs text-display-sm text-ink">Platform admin</h1>

        <AdminSignInForm
          csrf={<AdminCsrfField />}
          next={safeNextPath(next, "/admin", "/admin")}
        />
      </div>
    </div>
  );
}
