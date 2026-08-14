"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  createConsoleMailer,
  safeParseInput,
  sendMailSafely,
  signInSchema,
  signUpSchema,
} from "@whatsapp-os/core";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/cookies";
import { assertCsrf } from "@/lib/auth/csrf";
import { checkSignupAllowed, recordSignupAttempt } from "@/lib/auth/lockout";
import { requestContext } from "@/lib/auth/request";
import { signIn } from "@/lib/auth/signin";
import { signUp } from "@/lib/auth/signup";

/**
 * Sign-up and sign-in.
 *
 * Every mutating action calls assertCsrf first. The services in lib/auth do the
 * work; these functions handle validation, cookies and redirects, so the
 * interesting logic stays testable without a request context.
 */

export interface AuthFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** One message for every sign-in failure. See lib/auth/signin.ts. */
const INVALID_CREDENTIALS = "That username and password do not match.";

async function setSessionCookies(
  token: string,
  csrfSecret: string,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  /* Same value as the session's secret, so assertCsrf can bind to the row. */
  store.set(CSRF_COOKIE_NAME, csrfSecret, CSRF_COOKIE_OPTIONS);
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  await assertCsrf(formData);

  const parsed = safeParseInput(signUpSchema, {
    fullName: formData.get("fullName"),
    companyName: formData.get("companyName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    username: formData.get("username"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.ok) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.errors) {
      fieldErrors[issue.path] ??= issue.message;
    }
    return { message: "Check the highlighted fields.", fieldErrors };
  }

  const context = await requestContext();

  /*
   * Throttled per address. Unthrottled signup means one script can create
   * unlimited companies and burn the shared HaveIBeenPwned quota.
   */
  const allowed = await checkSignupAllowed(context.ip);
  if (allowed.locked) {
    return {
      message: "Too many sign-up attempts from this network. Try again later.",
    };
  }
  await recordSignupAttempt(context.ip);

  const result = await signUp(parsed.data, context);

  if (!result.ok) {
    switch (result.error.reason) {
      case "password_common":
        return {
          fieldErrors: {
            password: "That password is too common. Choose another.",
          },
        };
      case "password_breached":
        return {
          fieldErrors: {
            password:
              "That password has appeared in a data breach. Choose another.",
          },
        };
      case "phone_invalid":
        return { fieldErrors: { phone: result.error.message } };
      case "username_taken":
        return { fieldErrors: { username: "That username is taken." } };
      case "email_taken":
        return {
          fieldErrors: { email: "An account with that email already exists." },
        };
    }
  }

  const { value } = result;

  /*
   * After the commit. A mail failure cannot roll the account back and must not
   * try — the resend action is the recovery path. See sendMailSafely.
   */
  const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
  const verifyUrl = `${appUrl}/api/auth/verify?token=${value.verificationToken}`;

  await sendMailSafely(createConsoleMailer(), {
    to: parsed.data.email,
    subject: "Verify your email",
    text: `Welcome to whatsapp-os. Confirm your address:\n\n${verifyUrl}\n\nThe link expires in 24 hours.`,
  });

  await setSessionCookies(value.sessionToken, value.csrfSecret);

  redirect("/dashboard");
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  await assertCsrf(formData);

  const parsed = safeParseInput(signInSchema, {
    username: formData.get("username"),
    password: formData.get("password"),
  });

  if (!parsed.ok) {
    /*
     * Not the field-level errors. Reporting "that is not a valid username"
     * distinguishes a malformed guess from a well-formed one that does not
     * exist, which is the enumeration everything else here works to prevent.
     */
    return { message: INVALID_CREDENTIALS };
  }

  const context = await requestContext();
  const result = await signIn(parsed.data, context);

  if (!result.ok) {
    if (result.error.reason === "locked") {
      return {
        message:
          "Too many failed attempts. This account is locked for a short while.",
      };
    }
    return { message: INVALID_CREDENTIALS };
  }

  await setSessionCookies(result.value.sessionToken, result.value.csrfSecret);

  redirect("/dashboard");
}
