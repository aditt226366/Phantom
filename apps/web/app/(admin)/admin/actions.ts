"use server";

import { redirect } from "next/navigation";
import { safeParseInput, signInSchema } from "@whatsapp-os/core";
import { createConsoleMailer, sendMailSafely } from "@whatsapp-os/core";
import { writeAdminAudit } from "@/lib/admin-db";
import { issueAdminPasswordReset } from "@/lib/auth/admin-reset";
import { requireAdminSession } from "@/lib/auth/admin-session";
import {
  adminSignIn,
  assertAdminCsrf,
  endAdminSession,
  getAdminSession,
} from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import { safeNextPath } from "@/lib/auth/safe-next";

export interface AdminFormState {
  message?: string;
}

/** One message for every failure, exactly as on the tenant side. */
const INVALID = "That username and password do not match.";

export async function adminSignInAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  /* No session yet, so cookie-only. */
  await assertAdminCsrf(formData);

  const parsed = safeParseInput(signInSchema, {
    username: formData.get("username"),
    password: formData.get("password"),
  });

  if (!parsed.ok) return { message: INVALID };

  const context = await requestContext();
  const result = await adminSignIn(
    parsed.data.username,
    parsed.data.password,
    context,
  );

  if (!result.ok) {
    return {
      message:
        result.reason === "locked"
          ? "Too many failed attempts. Locked for a short while."
          : INVALID,
    };
  }

  /*
   * Constrained to /admin. A crafted ?next= must not be able to bounce a
   * freshly authenticated admin into the tenant app or off-site.
   */
  const next = safeNextPath(
    formData.get("next")?.toString(),
    "/admin",
    "/admin",
  );

  redirect(next);
}

export async function adminSignOutAction(formData: FormData): Promise<void> {
  const session = await getAdminSession();
  await assertAdminCsrf(formData, session);

  if (session) {
    const context = await requestContext();
    await writeAdminAudit({
      adminUserId: session.adminUserId,
      action: "admin.logout",
      ...(context.ip ? { ip: context.ip } : {}),
    });
  }

  await endAdminSession();
  redirect("/admin/sign-in");
}

/**
 * Send a reset link to a user, on their behalf.
 *
 * The token is never returned here. It goes to the address on file and this
 * function reports only that a link was sent — an operator who could read the
 * link could take any account with no trace in the user's inbox.
 *
 * Deliberately says the same thing whether or not the username exists. The
 * panel already lists companies, so this is not hiding much from an admin, but
 * an identical response keeps the audit trail the only place the distinction
 * is recorded.
 */
export async function adminResetPasswordAction(
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const username = formData.get("username")?.toString().trim() ?? "";
  if (!username) return { message: "Enter a username." };

  const context = await requestContext();
  const result = await issueAdminPasswordReset(
    session.adminUserId,
    username,
    context.ip,
  );

  if (result.ok && result.token && result.email) {
    const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
    await sendMailSafely(createConsoleMailer(), {
      to: result.email,
      subject: "Reset your password",
      text: `An administrator has started a password reset for your account. Every signed-in device has been signed out.

${appUrl}/reset-password?token=${result.token}

The link expires in one hour and can be used once.`,
    });
  }

  /* One message for both outcomes, and never the link. */
  return {
    message: "If that user exists, a reset link has been sent to them.",
  };
}
