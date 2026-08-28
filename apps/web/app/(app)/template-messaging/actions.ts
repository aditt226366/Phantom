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
