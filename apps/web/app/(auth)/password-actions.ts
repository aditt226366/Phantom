"use server";

import { redirect } from "next/navigation";
import {
  createConsoleMailer,
  forgotPasswordSchema,
  resetPasswordSchema,
  safeParseInput,
  sendMailSafely,
} from "@whatsapp-os/core";
import { assertCsrf } from "@/lib/auth/csrf";
import {
  consumeResetToken,
  requestPasswordReset,
} from "@/lib/auth/password-reset";
import { requestContext } from "@/lib/auth/request";
import { setPassword } from "@/lib/auth/set-password";

export interface PasswordFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Request a reset link.
 *
 * Always redirects to the same page, whether or not the address belongs to
 * anyone. "No account with that email" would turn this form into a membership
 * oracle for every address someone cares to try, with no password to guess and
 * no lockout to hit.
 */
export async function forgotPasswordAction(
  _previous: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  await assertCsrf(formData);

  const parsed = safeParseInput(forgotPasswordSchema, {
    email: formData.get("email"),
  });

  if (!parsed.ok) {
    /* Even a malformed address gets the same page — the shape of the response
       must not depend on anything about the input. */
    redirect("/forgot-password?sent=1");
  }

  const context = await requestContext();
  const request = await requestPasswordReset(parsed.data.email, context.ip);

  if (request.token) {
    const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
    await sendMailSafely(createConsoleMailer(), {
      to: request.email,
      subject: "Reset your password",
      text: `Someone asked to reset the password for this account.\n\n${appUrl}/reset-password?token=${request.token}\n\nThe link expires in one hour and can be used once. If this was not you, nothing has changed.`,
    });
  }

  redirect("/forgot-password?sent=1");
}

/** Set a new password from a reset link. */
export async function resetPasswordAction(
  _previous: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  await assertCsrf(formData);

  const parsed = safeParseInput(resetPasswordSchema, {
    token: formData.get("token"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.ok) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.errors) fieldErrors[issue.path] ??= issue.message;
    return { fieldErrors };
  }

  /*
   * Spent before the password is set, and atomically: two submissions of the
   * same link race on the row and exactly one wins.
   */
  const consumed = await consumeResetToken(parsed.data.token);

  if (!consumed.ok) {
    return {
      message: "That link has expired or has already been used.",
    };
  }

  const context = await requestContext();
  const result = await setPassword(
    consumed.companyId,
    consumed.userId,
    parsed.data.newPassword,
    "reset",
    context,
  );

  if (!result.ok) {
    /*
     * The token is already spent. Saying so plainly beats letting the user
     * retry against a link that no longer works.
     */
    return {
      message:
        result.reason === "password_common"
          ? "That password is too common. Request a new link and choose another."
          : "That password has appeared in a data breach. Request a new link and choose another.",
    };
  }

  /* No session issued: nobody was signed in, and a reset is exactly when you
     want the next step to be a deliberate sign-in. */
  redirect("/sign-in?reset=1");
}
