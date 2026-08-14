"use server";

import { redirect } from "next/navigation";
import { createConsoleMailer, sendMailSafely } from "@whatsapp-os/core";
import { AuditAction } from "@whatsapp-os/db";
import { audit } from "@/lib/auth/audit";
import { assertCsrf } from "@/lib/auth/csrf";
import { requestContext } from "@/lib/auth/request";
import { endSession, getSession } from "@/lib/auth/session";
import { reissueVerificationToken } from "@/lib/auth/verify-email";

/**
 * Shell actions.
 *
 * Both call requireSession-equivalent checks themselves rather than trusting
 * the layout. A layout is cached per segment and is not guaranteed to
 * re-execute on every navigation within it, so it is a redirect for the user's
 * benefit and never an authorization boundary.
 */

export async function signOutAction(formData: FormData): Promise<void> {
  const session = await getSession();

  /* Bound to the session row, not just the cookie — see lib/auth/csrf.ts. */
  await assertCsrf(formData, session);

  if (session) {
    const context = await requestContext();
    await audit(session.companyId, {
      action: AuditAction.LOGOUT,
      userId: session.userId,
      ...context,
    });
  }

  /* Revokes the row and clears both cookies. Logout is not advisory. */
  await endSession();

  redirect("/sign-in");
}

export async function resendVerificationAction(
  formData: FormData,
): Promise<void> {
  const session = await getSession();
  await assertCsrf(formData, session);

  if (!session) redirect("/sign-in");

  if (session.user.emailVerifiedAt) {
    /* Already done. Nothing to reissue, and no reason to say so loudly. */
    redirect("/dashboard");
  }

  const token = await reissueVerificationToken(
    session.companyId,
    session.userId,
  );

  const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";

  await sendMailSafely(createConsoleMailer(), {
    to: session.user.email,
    subject: "Verify your email",
    text: `Confirm your address:\n\n${appUrl}/api/auth/verify?token=${token}\n\nThe link expires in 24 hours.`,
  });

  redirect("/check-email");
}
