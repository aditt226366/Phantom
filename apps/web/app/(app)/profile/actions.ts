"use server";

import { cookies } from "next/headers";
import {
  changePasswordSchema,
  safeParseInput,
  verifyPassword,
} from "@whatsapp-os/core";
import { withCompany } from "@whatsapp-os/db";
import {
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/cookies";
import { assertCsrf } from "@/lib/auth/csrf";
import { requestContext } from "@/lib/auth/request";
import { requireSession } from "@/lib/auth/session";
import { createSessionRecord } from "@/lib/auth/session-store";
import { setPassword } from "@/lib/auth/set-password";

export interface ChangePasswordState {
  message?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
}

export async function changePasswordAction(
  _previous: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  /* Its own check, not the layout's — see rule 4 in CLAUDE.md. */
  const session = await requireSession();
  await assertCsrf(formData, session);

  const parsed = safeParseInput(changePasswordSchema, {
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.ok) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.errors) fieldErrors[issue.path] ??= issue.message;
    return { fieldErrors };
  }

  /*
   * Re-authenticate. A session proves possession of a cookie, not knowledge of
   * the password, and this is the flow someone holding a stolen cookie would
   * use to take the account for good.
   */
  const user = await withCompany(session.companyId, (db) =>
    db.user.findUnique({
      where: { id: session.userId },
      select: { passwordHash: true },
    }),
  );

  if (!user) return { message: "Something went wrong. Try again." };

  if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
    return { fieldErrors: { currentPassword: "That password is not correct." } };
  }

  /*
   * Reuse is refused against the stored hash as well as against the submitted
   * current password: the schema check catches the same string, this catches a
   * different string that happens to hash to the same account credential.
   */
  if (await verifyPassword(user.passwordHash, parsed.data.newPassword)) {
    return {
      fieldErrors: { newPassword: "That is your current password." },
    };
  }

  const context = await requestContext();
  const result = await setPassword(
    session.companyId,
    session.userId,
    parsed.data.newPassword,
    "change",
    context,
  );

  if (!result.ok) {
    return {
      fieldErrors: {
        newPassword:
          result.reason === "password_common"
            ? "That password is too common. Choose another."
            : "That password has appeared in a data breach. Choose another.",
      },
    };
  }

  /*
   * setPassword revoked every session, including this one. Mint a replacement
   * so the user stays on the page they are standing on rather than being
   * bounced to sign-in for doing the right thing.
   */
  const replacement = await createSessionRecord(
    session.companyId,
    session.userId,
    context,
  );

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, replacement.token, SESSION_COOKIE_OPTIONS);
  /* Re-minted to the new session's secret, so assertCsrf still binds. */
  store.set(
    CSRF_COOKIE_NAME,
    replacement.csrfSecret,
    CSRF_COOKIE_OPTIONS,
  );

  return {
    success:
      "Password changed. Every other signed-in device has been signed out.",
  };
}
