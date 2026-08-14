import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { CsrfField } from "@/components/ui/csrf-field";
import { requireSession } from "@/lib/auth/session";
import { resendVerificationAction, signOutAction } from "./actions";

/**
 * The application shell.
 *
 * requireSession() here is for the user's benefit — it redirects instead of
 * rendering chrome around nothing. It is NOT the authorization boundary:
 * layouts are cached per segment and are not guaranteed to re-execute on every
 * navigation within that segment, so every page and every action calls
 * requireSession() itself. React cache() makes the repeats free.
 *
 * The session lookup already loads the company and the user in one query, so a
 * request through the shell costs a single interactive transaction rather than
 * one for the session and another for the header.
 */
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession();

  return (
    <AppShell
      companyName={session.company.name}
      fullName={session.user.fullName}
      email={session.user.email}
      emailVerified={session.user.emailVerifiedAt !== null}
      signOutAction={signOutAction}
      resendAction={resendVerificationAction}
      /* Two instances: a form may only carry one field of a given name. */
      csrf={<CsrfField />}
      resendCsrf={<CsrfField />}
    >
      {children}
    </AppShell>
  );
}
