"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  INTEGRATION_PROVIDERS,
  JOB_NAMES,
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
  latestRepairRun,
  listCompanyIdsWithIntegrations,
  saveIntegrationSecrets,
  setCompanyBroadcastGap,
  setCompanyDeactivated,
  startRepairRun,
  writeAdminAudit,
} from "@/lib/admin-db";
import { systemQueue } from "@/lib/queue";
import { issueAdminPasswordReset } from "@/lib/auth/admin-reset";
import { verifyIntegration } from "@/lib/integrations/verify";
import { requireAdminSession } from "@/lib/auth/admin-session";
import {
  adminSignIn,
  assertAdminCsrf,
  endAdminSession,
  getAdminSession,
} from "@/lib/auth/admin-session";
import { evictWebhookSecrets } from "@/lib/webhook-secrets.ts";
import { applyVerificationEffects } from "@whatsapp-os/core";
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

  /*
   * Beside the revalidate, and for the same reason: something is holding a
   * stale copy of what just changed. The page holds a rendered badge; this
   * process holds a decrypted app secret, and a rotated secret that keeps
   * failing signatures for another minute reads exactly like a save that did
   * not work.
   *
   * Reaches THIS instance only. Others converge when their entries expire.
   */
  evictWebhookSecrets(companyId);

  const saved =
    result.saved.length === 0
      ? "Nothing changed."
      : `Saved ${result.saved.length} credential${result.saved.length === 1 ? "" : "s"}.`;

  /*
   * Save & Verify is the same save followed by a real provider call, so the
   * outcome the operator reads is the verification's, not the save's.
   */
  if (formData.get("intent")?.toString() === "verify") {
    const verified = await runVerification(
      companyId,
      provider,
      session.adminUserId,
    );

    return verified.success
      ? { success: `${saved} ${verified.success}` }
      : { success: saved, ...(verified.message ? { message: verified.message } : {}) };
  }

  return { success: saved };
}

/**
 * Check an integration against its provider.
 *
 * Shared by Save & Verify and by Test Connection, because they differ only in
 * whether a save happened first.
 */
async function runVerification(
  companyId: string,
  provider: IntegrationProviderName,
  adminUserId: string,
): Promise<IntegrationFormState> {
  const result = await verifyIntegration(companyId, provider);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId,
    action: "admin.integration.verified",
    ...(context.ip ? { ip: context.ip } : {}),
    /* The outcome, never the credential. `error` is already scrubbed. */
    metadata: {
      companyId,
      provider,
      ok: result?.ok ?? false,
      ...(result && !result.ok ? { kind: result.kind } : {}),
    },
  });

  /*
   * Everything that follows a successful verification lives in one place, so
   * this path and the worker's cannot drift. They did, and invisibly: commit 21
   * put the numbers refresh in the worker job only, and this - the button an
   * operator actually presses - never triggered it, so whatsapp_numbers stayed
   * empty and every inbound message was skipped as unknown_phone_number_id.
   *
   * A timestamp for the token, because the id must be unique per verification
   * rather than per company (R2): a stable one would make the second Save &
   * Verify inside BullMQ's retention window a silent no-op, which is exactly
   * the press somebody makes after fixing a credential.
   */
  await applyVerificationEffects(
    {
      companyId,
      verified: result?.ok === true,
      token: String(Date.now()),
    },
    {
      enqueue: (name, data, options) => systemQueue.add(name, data, options),
      onWarn: (message, fields) =>
        console.warn(`[verification] ${message}`, fields),
    },
  );

  /* Revalidated after the effects, so a refresh enqueued above is already in
     flight by the time the page re-renders. */
  revalidatePath(`/admin/companies/${companyId}/integrations`);

  if (!result) {
    return { message: "Nothing is stored for this provider yet." };
  }

  return result.ok
    ? { success: "Connection verified." }
    : { message: result.error };
}

export async function testIntegrationAction(
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

  return runVerification(companyId, provider, session.adminUserId);
}

/**
 * Delete a provider's stored credentials.
 *
 * A POST with CSRF and a confirmation step, for the same reason Deactivate has
 * one: it is destructive and unrecoverable. Nothing here can read a credential
 * back, so re-connecting means re-typing every value from the provider's own
 * console.
 */
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
    metadata: {
      companyId,
      provider,
      secretsRemoved: removed?.secretsRemoved ?? 0,
    },
  });

  revalidatePath(`/admin/companies/${companyId}/integrations`);
  /* Otherwise a disconnected integration keeps verifying deliveries from cache
     for up to the TTL. */
  evictWebhookSecrets(companyId);
  redirect(`/admin/companies/${companyId}/integrations`);
}

function isIntegrationProvider(
  value: string,
): value is IntegrationProviderName {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Platform maintenance                                                */
/* ------------------------------------------------------------------ */

/**
 * Re-verify every integration on the installation.
 *
 * Enumerates here and enqueues one job per company, because the worker cannot
 * enumerate — it holds no company context, so a cross-company SELECT returns
 * zero rows and succeeds.
 *
 * Two things stop a double-click becoming two rounds of provider calls at
 * Meta. A run started in the last few minutes blocks a new one outright, and
 * each job carries a deterministic id built from the run and the company, so
 * even within one run the queue collapses duplicates rather than fanning out
 * twice.
 *
 * The run row exists so the panel can answer the question that was actually
 * asked. "Repair every integration" is a question about the platform, and
 * per-integration timestamps cannot say whether the run finished — only that
 * some rows are newer than others.
 */
const REPAIR_COOLDOWN_MS = 5 * 60_000;

export async function repairIntegrationsAction(
  formData: FormData,
): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const existing = await latestRepairRun();
  const running =
    existing !== null &&
    Date.now() - existing.startedAt.getTime() < REPAIR_COOLDOWN_MS &&
    existing.completedCompanies < existing.totalCompanies;

  if (running) {
    /* Already in flight. Silently doing it again would double the load on
       every provider for no benefit. */
    revalidatePath("/admin");
    redirect("/admin");
  }

  const companyIds = await listCompanyIdsWithIntegrations();
  const runId = await startRepairRun(session.adminUserId, companyIds.length);

  for (const companyId of companyIds) {
    await systemQueue.add(
      JOB_NAMES.INTEGRATION_VERIFY,
      { companyId },
      { jobId: `repair:${runId}:${companyId}` },
    );
  }

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.integrations.repair",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: { runId, companies: companyIds.length },
  });

  revalidatePath("/admin");
  redirect("/admin");
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

/**
 * Change how fast one tenant's broadcasts send.
 *
 * An operator's call rather than a tenant's, because it is a judgement about
 * how hard to push a number against its quality rating - and the consequence
 * of getting it wrong lands on the platform's relationship with Meta, not only
 * on the tenant.
 *
 * It is pacing and NOT the limit. The messaging tier caps unique recipients
 * per rolling 24 hours and no gap gets past it; this only changes how quickly
 * a run works through what it is allowed.
 *
 * A broadcast already running is untouched - it copied the gap at start,
 * deliberately, so that changing this cannot re-pace something half sent.
 */
export async function setBroadcastGapAction(formData: FormData): Promise<void> {
  const session = await requireAdminSession();
  await assertAdminCsrf(formData, session);

  const companyId = formData.get("companyId")?.toString() ?? "";
  const raw = formData.get("gapMs")?.toString() ?? "";
  const gapMs = Number.parseInt(raw, 10);

  if (!companyId || Number.isNaN(gapMs)) {
    redirect(`/admin/companies/${companyId}`);
  }

  const changed = await setCompanyBroadcastGap(companyId, gapMs);

  const context = await requestContext();
  await writeAdminAudit({
    adminUserId: session.adminUserId,
    action: "admin.broadcast.gap.changed",
    ...(context.ip ? { ip: context.ip } : {}),
    /* The value and whether it landed. A rejected value is still a decision
       somebody made, and its absence from the log would be the confusing
       part when they say they changed it and nothing moved. */
    metadata: { companyId, gapMs, applied: changed },
  });

  revalidatePath(`/admin/companies/${companyId}`);
  redirect(`/admin/companies/${companyId}`);
}
