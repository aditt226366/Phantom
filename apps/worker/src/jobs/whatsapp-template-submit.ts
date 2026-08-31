import {
  decrypt,
  secretAad,
  type WhatsAppTemplateSubmitJob,
} from "@whatsapp-os/core";
import { createWhatsAppTemplate } from "@whatsapp-os/core/whatsapp";
import type { TemplateComponent } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Hand one already-persisted template to Meta, and record what it said.
 *
 * The Studio writes the row and enqueues; this is the only thing that calls
 * /{WABA_ID}/message_templates. The split is the same one the message send
 * uses, and for one of the same reasons — a Graph round trip does not belong
 * inside a request an operator is waiting on.
 *
 * It differs from the send in the way that matters most, though, and the
 * difference is worth stating because it is why this job is allowed retries at
 * all. A repeated send reaches a real customer twice and cannot be un-sent. A
 * repeated submission cannot: Meta refuses a duplicate name with a specific
 * error rather than creating a second template. So this keeps the default five
 * attempts where the send takes exactly one.
 *
 * Read, close, call, write. No provider call inside a company scope.
 */

export type TemplateSubmitResult =
  | "submitted"
  | "refused"
  | "already_submitted"
  | "unknown_template";

export async function handleWhatsAppTemplateSubmit(
  payload: WhatsAppTemplateSubmitJob,
): Promise<{ result: TemplateSubmitResult }> {
  const { companyId, templateId } = payload;

  /* 1. Read the template and its credentials, then close the scope. */
  const loaded = await withCompany(companyId, (db) =>
    db.whatsAppTemplate.findFirst({
      where: { id: templateId },
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        components: true,
        metaTemplateId: true,
        integrationId: true,
        integration: {
          select: { secrets: { select: { key: true, ciphertext: true } } },
        },
      },
    }),
  );

  if (!loaded) return { result: "unknown_template" };

  if (loaded.metaTemplateId) {
    /*
     * Meta has already named this template, so it has already been created.
     * Submitting again would be refused for a duplicate name, which is
     * harmless but produces a rejection reason describing our own bug rather
     * than anything the tenant did.
     */
    log.warn("template submit skipped: it already has a Meta id", {
      companyId,
      templateId,
    });
    return { result: "already_submitted" };
  }

  /* 2. Decrypt. CPU only, nothing open. */
  const secrets: Record<string, string> = {};
  for (const row of loaded.integration.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, loaded.integrationId, row.key),
    );
  }

  /*
   * 3. The call. The stored components go to the wire untouched — they are
   * what the Studio previewed, which is decision 10 and the reason there is no
   * re-assembly step anywhere on this path.
   */
  const outcome = await createWhatsAppTemplate(secrets, {
    name: loaded.name,
    language: loaded.language,
    category: loaded.category,
    components: loaded.components as unknown as TemplateComponent[],
  });

  /* 4. Write what happened. */
  if (!outcome.ok) {
    await withCompany(companyId, (db) =>
      db.whatsAppTemplate.updateMany({
        where: { id: templateId },
        data: {
          /*
           * Meta's own sentence, stored where the Studio shows it. REJECTED
           * rather than a status of our own: from the tenant's side a refusal
           * at submission and a refusal at review are the same event with the
           * same remedy, and inventing a second word for it would mean two
           * places in the UI that mean one thing.
           */
          status: "REJECTED",
          rejectedReason: outcome.error,
          statusUpdatedAt: new Date(),
        },
      }),
    );

    log.warn("Meta refused a template", {
      companyId,
      templateId,
      kind: outcome.kind,
      code: outcome.code,
    });

    return { result: "refused" };
  }

  await withCompany(companyId, (db) =>
    db.whatsAppTemplate.updateMany({
      where: { id: templateId },
      data: {
        metaTemplateId: outcome.metaTemplateId,
        /* Meta's word, not PENDING by assumption — it auto-approves some. */
        status: outcome.status,
        /* And Meta's category, which may not be the one that was asked for. */
        ...(outcome.category ? { category: outcome.category } : {}),
        rejectedReason: null,
        statusUpdatedAt: new Date(),
      },
    }),
  );

  return { result: "submitted" };
}
