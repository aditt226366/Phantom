import {
  decrypt,
  secretAad,
  type WhatsAppTemplateSyncJob,
} from "@whatsapp-os/core";
import { listWhatsAppTemplates } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Adopt the templates Meta already holds for this WABA.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * It reads /{WABA_ID}/message_templates and writes in anything this system has
 * never seen. Those are templates created in Business Manager, or by whoever
 * set the account up before this product existed — and they skip review here
 * because they have already been through it: Meta approved them, and the status
 * that comes back says so.
 *
 * It is NOT Meta's global pre-written catalogue, which is a separate endpoint
 * and a separate feature. Calling this the Library is accurate about what a
 * tenant sees — templates they can send without waiting — and the tab says
 * where they came from rather than implying a catalogue that is not wired up.
 *
 * It also closes half of R8's gap in the only direction that is possible: edits
 * made in Business Manager still never reach the edit log, but templates made
 * there stop being invisible.
 *
 * Idempotent by construction: it upserts on Meta's id, so running it twice
 * writes the same rows. Keeps the default five attempts.
 */

export async function handleWhatsAppTemplateSync(
  payload: WhatsAppTemplateSyncJob,
): Promise<{ adopted: number; updated: number }> {
  const { companyId } = payload;

  /* 1. Credentials, then close the scope. */
  const loaded = await withCompany(companyId, (db) =>
    db.integration.findFirst({
      where: { provider: "WHATSAPP_CLOUD" },
      select: {
        id: true,
        secrets: { select: { key: true, ciphertext: true } },
      },
    }),
  );

  if (!loaded) return { adopted: 0, updated: 0 };

  const secrets: Record<string, string> = {};
  for (const row of loaded.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, loaded.id, row.key),
    );
  }

  /* 2. The call. Nothing open. */
  const outcome = await listWhatsAppTemplates(secrets);

  if (!outcome.ok) {
    log.warn("could not read templates from Meta", {
      companyId,
      kind: outcome.kind,
    });
    /* Thrown so BullMQ retries — reading is safe to repeat. */
    throw new Error(`Template sync failed: ${outcome.error}`);
  }

  /* 3. Write. */
  let adopted = 0;
  let updated = 0;

  for (const template of outcome.templates) {
    const result = await withCompany(companyId, async (db, scoped) => {
      const existing = await db.whatsAppTemplate.findFirst({
        where: { metaTemplateId: template.id },
        select: { id: true },
      });

      if (existing) {
        await db.whatsAppTemplate.updateMany({
          where: { id: existing.id },
          data: {
            status: template.status,
            category: template.category,
            rejectedReason: template.rejectedReason,
            statusUpdatedAt: new Date(),
          },
        });
        return "updated" as const;
      }

      /*
       * createdByUserId stays null, and that is the marker the Library tab
       * reads. Nobody here made this one, so attributing it to whoever pressed
       * Sync would put a name against work they did not do.
       */
      await db.whatsAppTemplate.create({
        data: {
          companyId: scoped,
          integrationId: loaded.id,
          name: template.name,
          language: template.language,
          category: template.category,
          components: template.components as never,
          status: template.status,
          metaTemplateId: template.id,
          rejectedReason: template.rejectedReason,
          statusUpdatedAt: new Date(),
        },
      });
      return "adopted" as const;
    });

    if (result === "adopted") adopted++;
    else updated++;
  }

  return { adopted, updated };
}
