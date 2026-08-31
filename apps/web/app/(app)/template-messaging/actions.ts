"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  JOB_NAMES,
  templateSubmitJobId,
} from "@whatsapp-os/core/queues";
import {
  buildComponents,
  validateTemplate,
  type TemplateDraft,
} from "@whatsapp-os/core/whatsapp";
import { recordTemplateEdit, withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { systemQueue } from "@/lib/queue";

/**
 * Write the template, then enqueue it. Nothing here talks to Meta.
 *
 * The same split as the composer, for the same reason: a Graph round trip does
 * not belong inside a request somebody is waiting on, and a submission Meta
 * accepted with no row to attach the id to is unrecoverable.
 */

export interface StudioState {
  error?: string;
}

/**
 * Validation runs again here, and it is the same function the Studio ran.
 *
 * Not defence in depth for its own sake: the Studio's submit is disabled on
 * these rules, so reaching this branch means a hand-made POST or a stale page,
 * and the alternative to refusing is sending Meta something it will reject
 * while telling the tenant it went through.
 */
function parseDraft(raw: string): TemplateDraft | null {
  try {
    const parsed = JSON.parse(raw) as TemplateDraft;
    return typeof parsed?.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  const draft = parseDraft(String(formData.get("draft") ?? ""));
  if (!draft) redirect("/template-messaging?error=malformed");

  if (validateTemplate(draft).length > 0) {
    redirect("/template-messaging?error=invalid");
  }

  const components = buildComponents(draft);

  const created = await withCompany(session.companyId, async (db, companyId) => {
    const integration = await db.integration.findFirst({
      where: { provider: "WHATSAPP_CLOUD" },
      select: { id: true },
    });

    if (!integration) return null;

    /*
     * @@unique(company_id, name, language) is the real uniqueness check, and it
     * is a database question rather than a validation one - which is why
     * validateTemplate deliberately does not try to answer it. A duplicate
     * throws here and the caller sees the conflict.
     */
    const template = await db.whatsAppTemplate.create({
      data: {
        companyId,
        integrationId: integration.id,
        name: draft.name,
        language: draft.language,
        category: draft.category,
        components: components as never,
        status: "PENDING",
        createdByUserId: session.userId,
      },
      select: { id: true },
    });

    /* The first entry in the log. Every submission is an edit, including the
       one that creates the template - otherwise the count starts at zero for
       something that has already used one of Meta's. */
    await recordTemplateEdit(db, companyId, {
      templateId: template.id,
      components,
      editedByUserId: session.userId,
    });

    return template.id;
  });

  if (!created) redirect("/template-messaging?error=not_connected");

  /* Outside the scope: Redis is not worth a held connection. */
  await systemQueue.add(
    JOB_NAMES.WHATSAPP_TEMPLATE_SUBMIT,
    { companyId: session.companyId, templateId: created },
    { jobId: templateSubmitJobId(created, 0) },
  );

  revalidatePath("/template-messaging");
  redirect(`/template-messaging/${created}`);
}

/**
 * Fix and resubmit.
 *
 * The Edit button is never gated on the quota (R8) — this attempts the change
 * and lets Meta refuse it. The count the Studio shows is a floor, because Meta
 * counts edits made in Business Manager and those never reach our table, so a
 * disabled button would be this app telling somebody they have no edits left
 * on the strength of a number it cannot know.
 *
 * The row goes back to PENDING with its previous reason cleared, because it is
 * genuinely under review again and a stale rejection sitting under a PENDING
 * badge reads as a new one.
 */
export async function resubmitTemplateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  const templateId = String(formData.get("templateId") ?? "");
  const draft = parseDraft(String(formData.get("draft") ?? ""));

  if (!templateId || !draft) redirect("/template-messaging?error=malformed");
  if (validateTemplate(draft).length > 0) {
    redirect(`/template-messaging/${templateId}?error=invalid`);
  }

  const components = buildComponents(draft);

  const attempt = await withCompany(session.companyId, async (db, companyId) => {
    const existing = await db.whatsAppTemplate.findFirst({
      where: { id: templateId },
      select: { id: true },
    });

    /* Rule 6: not yours means it does not exist. */
    if (!existing) return null;

    await db.whatsAppTemplate.updateMany({
      where: { id: templateId },
      data: {
        name: draft.name,
        language: draft.language,
        category: draft.category,
        components: components as never,
        status: "PENDING",
        /*
         * Cleared with the resubmission, and cleared for the same reason the
         * message retry clears a failure's error columns: a row that is under
         * review again must not still carry last time's verdict.
         *
         * metaTemplateId goes too. Meta treats an edit as a new submission and
         * answers with an id; keeping the old one would make the submit job
         * refuse this as already-named and the button would do nothing.
         */
        metaTemplateId: null,
        rejectedReason: null,
        statusUpdatedAt: null,
      },
    });

    await recordTemplateEdit(db, companyId, {
      templateId,
      components,
      editedByUserId: session.userId,
    });

    /* The attempt number for the job id (R2), counted from the log rather than
       kept anywhere - the same reasoning as the quota it is derived from. */
    return db.whatsAppTemplateEdit.count({ where: { companyId, templateId } });
  });

  if (attempt === null) redirect("/template-messaging?error=gone");

  await systemQueue.add(
    JOB_NAMES.WHATSAPP_TEMPLATE_SUBMIT,
    { companyId: session.companyId, templateId },
    { jobId: templateSubmitJobId(templateId, attempt) },
  );

  revalidatePath("/template-messaging");
  revalidatePath(`/template-messaging/${templateId}`);
  redirect(`/template-messaging/${templateId}`);
}

/**
 * Ask the worker to read what Meta holds.
 *
 * A job rather than a Graph call in the request, and for the same reason the
 * numbers page refuses to fetch on render: a provider round trip inside a page
 * load is a page that fails when Meta is slow. The button enqueues; the tab
 * shows what the last sync found.
 */
export async function syncTemplatesAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  /*
   * A4: no feature section is open to an unverified workspace, and a
   * server action is reachable by its id whether or not a page rendered
   * a control for it. This throws rather than returning a verdict -
   * there is no way to call it and carry on by mistake.
   */
  await assertFeatureAccess();

  await systemQueue.add(JOB_NAMES.WHATSAPP_TEMPLATE_SYNC, {
    companyId: session.companyId,
  });

  revalidatePath("/template-messaging");
  redirect("/template-messaging?view=library");
}
