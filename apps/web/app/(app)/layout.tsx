import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { VerificationBanner } from "@/components/brand/verification-banner";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { blockedCopy } from "@/lib/kyc-display";
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

  /*
   * The banner only. This is NOT where the gate is enforced - see rule 4 and
   * the note in lib/auth/feature-gate.ts: a layout is cached per segment and
   * is not guaranteed to re-execute on every navigation within it, so a
   * refusal here would be one a tenant can navigate around. Every page and
   * every action does its own check.
   *
   * React cache() makes this call free for the page that is about to repeat
   * it.
   */
  const access = await getFeatureAccess();

  return (
    <AppShell
      companyName={session.company.name}
      fullName={session.user.fullName}
      email={session.user.email}
      emailVerified={session.user.emailVerifiedAt !== null}
      passwordBreached={session.user.passwordBreachedAt !== null}
      signOutAction={signOutAction}
      resendAction={resendVerificationAction}
      /* Two instances: a form may only carry one field of a given name. */
      csrf={<CsrfField />}
      resendCsrf={<CsrfField />}
      verificationBanner={
        access.allowed ? null : (
          <VerificationBanner
            /* The gate's own reason, so the banner and the blocked page a
               click away cannot describe different situations. */
            message={blockedCopy(access.reason).banner}
            className="mb-lg"
          />
        )
      }
    >
      {children}
    </AppShell>
  );
}
