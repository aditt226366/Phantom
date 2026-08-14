"use server";

import { redirect } from "next/navigation";
import { safeParseInput, signInSchema } from "@whatsapp-os/core";
import { writeAdminAudit } from "@/lib/admin-db";
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
