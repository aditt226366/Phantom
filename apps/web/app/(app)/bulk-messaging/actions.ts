"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Papa from "papaparse";
import {
  JOB_NAMES,
  DEFAULT_JOB_OPTIONS,
  broadcastStartJobId,
} from "@whatsapp-os/core";
import {
  buildAudience,
  mappingGaps,
  type ColumnMapping,
} from "@whatsapp-os/core/bulk";
import {
  Prisma,
  RECIPIENT_BATCH,
  insertRecipientBatch,
  resolveAudience,
  withCompany,
} from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { needsTypedConfirmation } from "@/lib/bulk-display";
import { systemQueue } from "@/lib/queue";
import { templateVariables } from "@whatsapp-os/core/whatsapp";

/**
 * The import wizard's three steps, and starting the run.
 *
 * Every one of them calls assertFeatureAccess. A4 gates bulk messaging like
 * every other section, and the gate has to be on the IMPORT rather than only
 * on the send button - an unverified company must not be able to reach the
 * upload at all, let alone stage ten thousand strangers' phone numbers in
 * somebody's database.
 */

/** Rows we will accept from one upload. */
const MAX_IMPORT_ROWS = 20_000;

/** Bytes. A 20k-row list of five short columns is well under a megabyte. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ImportState {
  message?: string;
}

/**
 * Step one: read the file, and hold it for the mapping step.
 *
 * Parsed on the SERVER, from the uploaded bytes, even though papaparse would
 * run perfectly well in the browser. The audience that comes out of this
 * decides who gets messaged, so it is built from the file rather than from
 * whatever a client posted back - the same reason the KYC upload decides a
 * file's type from its bytes rather than from the browser's Content-Type.
 */
export async function importListAction(
  _previous: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const file = formData.get("file");
  const templateId = String(formData.get("templateId") ?? "");
  const whatsappNumberId = String(formData.get("whatsappNumberId") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!templateId || !whatsappNumberId) {
    return { message: "Choose a template and a number to send from." };
  }

  if (!(file instanceof File) || file.size === 0) {
    return { message: "No file was attached. Choose a CSV and try again." };
  }

  if (file.size > MAX_IMPORT_BYTES) {
    return {
      message:
        "That file is larger than 5 MB. Split the list, or remove columns the message does not use.",
    };
  }

  const text = await file.text();

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    /* Everything is a string. papaparse's dynamicTyping would read a phone
       number as a float and lose the leading zero and the precision both. */
    dynamicTyping: false,
    transformHeader: (header) => header.trim(),
  });

  const rows = parsed.data.filter((row) => row && typeof row === "object");
  const headers = (parsed.meta.fields ?? []).filter((h) => h.length > 0);

  if (headers.length === 0) {
    return {
      message:
        "That file has no header row. The first line must name the columns, so they can be mapped to the message.",
    };
  }

  if (rows.length === 0) {
    return { message: "That file has a header and no rows." };
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      message: `That file has ${rows.length.toLocaleString()} rows and the limit is ${MAX_IMPORT_ROWS.toLocaleString()}. Split it and send in batches.`,
    };
  }

  const broadcastId = await withCompany(session.companyId, async (db, companyId) => {
    /* Rule 6 for both: a template or a number that is not yours does not
       exist, and the create would fail on the foreign key anyway - this makes
       it a message rather than a 500. */
    const template = await db.whatsAppTemplate.findFirst({
      where: { id: templateId },
      select: { id: true, status: true },
    });
    const number = await db.whatsAppNumber.findFirst({
      where: { id: whatsappNumberId },
      select: { id: true },
    });

    if (!template || !number) return null;
    if (template.status !== "APPROVED") return null;

    const company = await db.company.findFirst({
      where: { id: companyId },
      select: { broadcastGapMs: true },
    });

    const broadcast = await db.broadcast.create({
      data: {
        companyId,
        name: name.length > 0 ? name.slice(0, 120) : file.name.slice(0, 120),
        templateId,
        whatsappNumberId,
        /* Frozen here, so changing the tenant setting cannot re-pace a run
           that is already going. */
        gapMs: company?.broadcastGapMs ?? 800,
        sourceFilename: file.name.slice(0, 255),
        sourceRows: rows,
        sourceHeaders: headers,
        parsedCount: rows.length,
        createdByUserId: session.userId,
      },
      select: { id: true },
    });

    return broadcast.id;
  });

  if (!broadcastId) {
    return {
      message:
        "That template is not approved, or the number is not one of yours. Only an approved template can be sent to a list.",
    };
  }

  redirect(`/bulk-messaging/${broadcastId}/map`);
}

/**
 * Step two: the mapping, and the audience it produces.
 *
 * The whole cleaning pipeline runs here rather than at confirm, because the
 * counts ARE the confirm screen. A tenant who mapped the wrong column needs to
 * see "1,204 unparseable" before the screen that offers a send button, not
 * after it.
 */
export async function mapColumnsAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const broadcastId = String(formData.get("broadcastId") ?? "");
  if (!broadcastId) return;

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    const broadcast = await db.broadcast.findFirst({
      where: { id: broadcastId, status: "DRAFT" },
      select: {
        id: true,
        sourceRows: true,
        template: { select: { components: true } },
      },
    });

    if (!broadcast || !Array.isArray(broadcast.sourceRows)) return null;

    const variableCount = templateVariables(
      extractBody(broadcast.template.components),
    ).length;

    const mapping: ColumnMapping = {
      phone: String(formData.get("phoneColumn") ?? ""),
      variables: Object.fromEntries(
        Array.from({ length: variableCount }, (_, i) => [
          String(i + 1),
          String(formData.get(`variable_${i + 1}`) ?? ""),
        ]),
      ),
    };

    /* Incomplete mapping is refused rather than filled with blanks. A message
       with a hole in it is one every recipient gets wrong. */
    if (mappingGaps(mapping, variableCount).length > 0) return null;

    const rows = broadcast.sourceRows as unknown as Record<string, string>[];
    const built = buildAudience(rows, mapping);
    const resolved = await resolveAudience(db, companyId, built.recipients);

    await db.broadcast.update({
      where: { id: broadcastId },
      data: {
        columnMapping: mapping as unknown as object,
        invalidCount: built.counts.invalid,
        duplicateCount: built.counts.duplicate,
        existingCount: resolved.existingCount,
        optedOutCount: resolved.optedOutCount,
        recipientCount: resolved.recipients.length,
      },
    });

    /* Rebuilt from scratch on every mapping change, so going back and
       remapping cannot leave the audience of the previous attempt behind. */
    await db.broadcastRecipient.deleteMany({ where: { broadcastId } });

    return resolved.recipients;
  });

  if (!outcome) return;

  /*
   * Written in batches, each its own scope. withCompany holds a pooled
   * connection and times out after five seconds, so twenty thousand rows in
   * one statement is both over that and a lock other requests wait behind.
   */
  for (let at = 0; at < outcome.length; at += RECIPIENT_BATCH) {
    const slice = outcome.slice(at, at + RECIPIENT_BATCH);
    await withCompany(session.companyId, (db, companyId) =>
      insertRecipientBatch(db, companyId, broadcastId, slice),
    );
  }

  redirect(`/bulk-messaging/${broadcastId}/confirm`);
}

/**
 * Step three: send it.
 *
 * The typed confirmation for anything over a thousand is checked here and not
 * only in the form. A POST does not have to come from the page, and this is the
 * button that messages ten thousand strangers.
 */
export async function startBroadcastAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const broadcastId = String(formData.get("broadcastId") ?? "");
  const typed = String(formData.get("confirmCount") ?? "").trim();
  if (!broadcastId) return;

  const started = await withCompany(session.companyId, async (db, companyId) => {
    const broadcast = await db.broadcast.findFirst({
      where: { id: broadcastId, status: "DRAFT" },
      select: { id: true, recipientCount: true },
    });

    if (!broadcast || broadcast.recipientCount === 0) return false;

    /*
     * The typed confirmation, enforced here and not only on the form. A POST
     * does not have to come from the page, and this is the button that
     * messages ten thousand strangers.
     */
    if (
      needsTypedConfirmation(broadcast.recipientCount) &&
      typed !== String(broadcast.recipientCount)
    ) {
      return false;
    }

    const { count } = await db.broadcast.updateMany({
      /* Guarded on DRAFT, so two tabs pressing send produce one run rather
         than two schedules over the same recipients. */
      where: { id: broadcastId, companyId, status: "DRAFT" },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        /*
         * The audience is now broadcast_recipients, so the uploaded copy goes.
         * Keeping a second copy of a customer list in a column nothing reads
         * is exactly the quiet retention this column's migration argues
         * against - and DbNull is how a nullable Json column is actually
         * cleared, where `null` alone is a JSON null value.
         */
        sourceRows: Prisma.DbNull,
        sourceHeaders: Prisma.DbNull,
      },
    });

    return count === 1;
  });

  if (!started) {
    redirect(`/bulk-messaging/${broadcastId}/confirm?error=1`);
  }

  await systemQueue.add(
    JOB_NAMES.BROADCAST_START,
    { companyId: session.companyId, broadcastId, scheduledSoFar: 0 },
    {
      jobId: broadcastStartJobId(broadcastId, 0),
      ...DEFAULT_JOB_OPTIONS,
    },
  );

  revalidatePath("/bulk-messaging");
  redirect(`/bulk-messaging/${broadcastId}`);
}

/** The BODY text out of a stored component array, or empty if there is none. */
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return "";

  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as Record<string, unknown>)["type"] === "BODY"
    ) {
      const text = (component as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
    }
  }

  return "";
}

/* ------------------------------------------------------------------------- *
 * Running, pausing, stopping
 * ------------------------------------------------------------------------- */

/**
 * Set a broadcast's status, guarded on the status it is coming from.
 *
 * Guarded because two tabs are ordinary: somebody pauses in one and cancels in
 * the other, and without the guard the second write silently overrides the
 * first in whichever order they land. With it, the second is a no-op and the
 * page it revalidates shows what actually happened.
 */
async function transition(
  formData: FormData,
  from: readonly ("RUNNING" | "PAUSED")[],
  to: "RUNNING" | "PAUSED" | "CANCELLED",
): Promise<string | null> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const broadcastId = String(formData.get("broadcastId") ?? "");
  if (!broadcastId) return null;

  const moved = await withCompany(session.companyId, async (db, companyId) => {
    const { count } = await db.broadcast.updateMany({
      where: { id: broadcastId, companyId, status: { in: [...from] } },
      data: {
        status: to,
        /* Cancelling is an ending; pausing is not. */
        ...(to === "CANCELLED" ? { finishedAt: new Date() } : {}),
      },
    });

    return count === 1;
  });

  revalidatePath(`/bulk-messaging/${broadcastId}`);
  revalidatePath("/bulk-messaging");

  return moved ? broadcastId : null;
}

/**
 * Stop sending, now.
 *
 * Nothing is removed from Redis. Every delayed send job reads the broadcast's
 * status as it wakes and declines - which is why this is one UPDATE and takes
 * effect on the very next message rather than after a sweep of a queue that is
 * being consumed while it is swept.
 */
export async function pauseBroadcastAction(formData: FormData): Promise<void> {
  await transition(formData, ["RUNNING"], "PAUSED");
}

/**
 * Carry on from where it stopped.
 *
 * The re-schedule counts what has already been handed to the queue and passes
 * it as scheduledSoFar, so the remainder continues the original pace instead
 * of going out in one burst - which is what a resume that restarted at zero
 * would do, at the exact moment somebody had paused because something looked
 * wrong.
 *
 * The run number in the job id is the count of resumes. BullMQ keeps completed
 * ids for an hour and refuses a duplicate silently, so a pause and resume
 * inside that hour would otherwise be dropped and the button would look dead.
 */
export async function resumeBroadcastAction(formData: FormData): Promise<void> {
  const broadcastId = await transition(formData, ["PAUSED"], "RUNNING");
  if (!broadcastId) return;

  const session = await requireSession();

  const scheduledSoFar = await withCompany(session.companyId, (db, companyId) =>
    db.broadcastRecipient.count({
      where: { companyId, broadcastId, state: { not: "PENDING" } },
    }),
  );

  await systemQueue.add(
    JOB_NAMES.BROADCAST_START,
    { companyId: session.companyId, broadcastId, scheduledSoFar },
    {
      jobId: broadcastStartJobId(broadcastId, Date.now()),
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Stop for good.
 *
 * Cancellable from RUNNING or PAUSED. A paused broadcast is the one somebody
 * is most likely to abandon - they stopped it because something was wrong -
 * and a Cancel that only appeared while running would make them resume first,
 * sending more messages on the way to stopping.
 *
 * Messages already handed to Meta are not recalled, because they cannot be.
 * What stops is everything still in the queue, and each of those jobs records
 * its own refusal so the report says what happened rather than going quiet.
 */
export async function cancelBroadcastAction(formData: FormData): Promise<void> {
  await transition(formData, ["RUNNING", "PAUSED"], "CANCELLED");
}
