"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  INTEGRATION_PROVIDERS,
  echoableValues,
  integrationFields,
  integrationSaveSchema,
  safeParseInput,
  signInSchema,
  type IntegrationProviderName,
} from "@whatsapp-os/core";
import { createConsoleMailer, sendMailSafely } from "@whatsapp-os/core";
import {
  disconnectIntegration,
  saveIntegrationSecrets,
  setCompanyDeactivated,
  writeAdminAudit,
} from "@/lib/admin-db";
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

/**
 * The state a failed credential save hands back to the browser.
 *
 * `values` is the load-bearing field, and it carries non-secret entries only —
 * see echoableValues(). React serialises this object into the HTML of the
 * response, so anything in it has been disclosed to the page, its cache, and
 * anything logging response bodies.
 */
export interface IntegrationFormState {
  message?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
  /** Non-secret submitted values, so the form can repopulate them. */
  values?: Record<string, string>;
}

export async function saveIntegrationAction(
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const companyId = formData.get("companyId")?.toString() ?? "";
  const provider = formData.get("provider")?.toString() ?? "";

  if (!isIntegrationProvider(provider)) {
    return { message: "Unknown provider." };
  }

  const submitted: Record<string, string> = {};
  for (const field of integrationFields(provider)) {
    submitted[field.key] = formData.get(field.key)?.toString() ?? "";
  }

  const parsed = safeParseInput(integrationSaveSchema(provider), submitted);

  if (!parsed.ok) {
    /* safeParseInput labels an object-level refinement "(root)", not "". */
    const ROOT = "(root)";

    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.errors) {
      if (issue.path !== ROOT) fieldErrors[issue.path] ??= issue.message;
    }

    return {
      fieldErrors,
      /*
       * Never the raw submission. A token echoed here is a token in the page
       * source — the one place this panel is otherwise careful never to put it.
       */
      values: echoableValues(submitted),
      message:
        parsed.errors.find((issue) => issue.path === ROOT)?.message ??
        "Check the highlighted fields. Secret values must be re-entered.",
    };
  }

  const result = await saveIntegrationSecrets(companyId, provider, parsed.data);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.integration.saved",
    ...(context.ip ? { ip: context.ip } : {}),
    /* Key names, never values. */
    metadata: { companyId, provider, keys: result.saved },
  });

  revalidatePath(`/admin/companies/${companyId}/integrations`);

  return {
    success:
      result.saved.length === 0
        ? "Nothing changed."
        : `Saved ${result.saved.length} credential${result.saved.length === 1 ? "" : "s"}.`,
  };
}

export async function disconnectIntegrationAction(
  formData: FormData,
): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const companyId = formData.get("companyId")?.toString() ?? "";
  const provider = formData.get("provider")?.toString() ?? "";

  if (!isIntegrationProvider(provider)) return;

  const removed = await disconnectIntegration(companyId, provider);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.integration.disconnected",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { companyId, provider, removed },
  });

  revalidatePath(`/admin/companies/${companyId}/integrations`);
}

function isIntegrationProvider(
  value: string,
): value is IntegrationProviderName {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Deactivation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Suspend or restore a workspace.
 *
 * A POST with CSRF, never a link.
 *
 * The confirmation *page* is a GET — rendering it is safe and idempotent, and
 * it is what ?confirm= addresses. The act itself cannot be: a URL that
 * deactivates on GET is reachable by a browser preloading a hovered link, by a
 * corporate mail scanner following it out of an alert, and by any prefetch.
 * The consequence is a live customer losing access to their account because
 * somebody's security appliance was thorough.
 *
 * Reactivation exists for a duller reason: without it, an operator's misclick
 * is recoverable only by hand-written SQL against production.
 */
async function setDeactivation(
  formData: FormData,
  deactivated: boolean,
): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const companyId = formData.get("companyId")?.toString() ?? "";
  if (!companyId) return;

  const changed = await setCompanyDeactivated(companyId, deactivated);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: deactivated ? "admin.company.deactivated" : "admin.company.reactivated",
    ...(context.ip ? { ip: context.ip } : {}),
    /* `changed: false` means it was already in that state. */
    metadata: { companyId, changed },
  });

  revalidatePath(`/admin/companies/${companyId}`);
  redirect(`/admin/companies/${companyId}`);
}

export async function deactivateCompanyAction(
  formData: FormData,
): Promise<void> {
  await setDeactivation(formData, true);
}

export async function reactivateCompanyAction(
  formData: FormData,
): Promise<void> {
  await setDeactivation(formData, false);
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

  if (result.refused === "company-deactivated") {
    /*
     * The one outcome worth distinguishing, and it is not an enumeration risk:
     * the operator is already looking at the company's page, so this tells
     * them nothing they cannot see.
     *
     * Saying "a link was sent" here would be a lie with a long tail —
     * app_resolve_company() refuses the 'password_reset' kind for a
     * deactivated company, so the link cannot work, and the person debugging
     * it would start with the mail server.
     */
    return {
      message:
        "This company is deactivated, so a reset link could not be used. Reactivate it first.",
    };
  }

  /* One message for both remaining outcomes, and never the link. */
  return {
    message: "If that user exists, a reset link has been sent to them.",
  };
}
