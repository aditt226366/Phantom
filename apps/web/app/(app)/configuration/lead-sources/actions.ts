"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkSheetAccess, listSheetTabs, readSheetValues } from "@whatsapp-os/core";
import { mappingGaps, type ColumnMapping } from "@whatsapp-os/core/bulk";
import {
  POLL_INTERVAL_DEFAULT_SECONDS,
  clampPollInterval,
  parseSheetRef,
  toRecords,
} from "@whatsapp-os/core/leads";
import { anchorHash } from "@whatsapp-os/core/leads-server";
import { templateVariables } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { companyGoogleSecrets } from "@/lib/lead-sources/credentials";
import {
  scheduleLeadSourcePoll,
  unscheduleLeadSourcePoll,
} from "@/lib/lead-sources/scheduler";

/**
 * Binding a sheet, mapping it, and switching it on and off.
 *
 * Every one of them calls assertFeatureAccess. A4 gates lead sources like every
 * other section, and the gate has to be on the BINDING rather than only on the
 * send - an unverified company must not be able to point us at a spreadsheet of
 * strangers' phone numbers at all, let alone start a job that reads it every
 * thirty seconds.
 */

export interface BindState {
  message?: string;
  /** Echoed back so a failed save does not lose what somebody typed. */
  values?: { name: string; sheetUrl: string };
}

/**
 * Step one: bind the sheet, and prove we can actually see it.
 *
 * The access check is not optional and is not deferred to the first poll. A
 * tenant who pastes a URL and never shares the sheet is the single most common
 * failure this feature has, and deferring it means the failure appears as
 * nothing at all: a binding that looks configured, sitting on a page that says
 * it is polling, contacting nobody. Checking on save turns it into a sentence
 * beside the field they just filled in.
 */
export async function bindSheetAction(
  _previous: BindState,
  formData: FormData,
): Promise<BindState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const name = String(formData.get("name") ?? "").trim();
  const pasted = String(formData.get("sheetUrl") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "");
  const whatsappNumberId = String(formData.get("whatsappNumberId") ?? "");
  /*
   * The second member of the action column, decided here and nowhere else.
   *
   * A FLOW binding names a flow VERSION and no template: the template it sends
   * is the version's entry template, which is the same row the flow itself
   * opens with. Storing a second copy on the binding would be a second thing
   * to keep in step when the flow is republished onto a different one.
   */
  const actionKind = formData.get("actionKind") === "FLOW" ? "FLOW" : "TEMPLATE";
  const flowVersionId = String(formData.get("flowVersionId") ?? "");
  const values = { name, sheetUrl: pasted };

  if (!whatsappNumberId) {
    return { message: "Choose a number to send from.", values };
  }

  if (actionKind === "TEMPLATE" && !templateId) {
    return { message: "Choose a template to send.", values };
  }

  if (actionKind === "FLOW" && !flowVersionId) {
    return { message: "Choose a flow to start.", values };
  }

  const ref = parseSheetRef(pasted);

  if (!ref.ok) return { message: ref.reason, values };

  /* Read outside withCompany: a Graph or Google call inside a transaction
     holds a pooled connection across a network round trip. */
  const secrets = await companyGoogleSecrets(session.companyId);

  if (!secrets) {
    return {
      message:
        "Google Sheets is not connected for this workspace yet. Ask your platform contact to add the service account, then come back.",
      values,
    };
  }

  const access = await checkSheetAccess(secrets, ref.spreadsheetId);

  if (!access.ok) {
    return { message: shareFailureSentence(access.kind, access.error), values };
  }

  const tabs = await listSheetTabs(secrets, ref.spreadsheetId);

  if (!tabs.ok || tabs.tabs.length === 0) {
    return {
      message: "That spreadsheet has no tabs we can read.",
      values,
    };
  }

  /*
   * The tab they were looking at when they copied the link, when the link said
   * so. It is very often the one they mean, and picking the wrong tab imports a
   * different list and reports no error at all.
   */
  const chosen =
    tabs.tabs.find((tab) => tab.sheetId === ref.gid) ?? tabs.tabs[0]!;

  const leadSourceId = await withCompany(
    session.companyId,
    async (db, companyId) => {
      /* Rule 6 for both: a template or a number that is not yours does not
         exist. The create would fail on the foreign key anyway; this makes it
         a sentence rather than a 500. */
      const number = await db.whatsAppNumber.findFirst({
        where: { id: whatsappNumberId },
        select: { id: true },
      });

      if (!number) return null;

      /*
       * For a flow, the version has to be the one that is LIVE - not merely
       * published once. A superseded version would put every row of this sheet
       * into a tree the tenant has stopped using, and nothing would say so.
       */
      const version =
        actionKind === "FLOW"
          ? await db.flowVersion.findFirst({
              where: { id: flowVersionId, publishedAt: { not: null } },
              select: {
                id: true,
                template: { select: { id: true, status: true } },
                flow: { select: { publishedVersionId: true, archivedAt: true } },
              },
            })
          : null;

      if (actionKind === "FLOW") {
        if (
          !version ||
          version.flow.publishedVersionId !== version.id ||
          version.flow.archivedAt !== null
        ) {
          return null;
        }
      }

      /* Rule 6: a template that is not yours does not exist. The create would
         fail on the foreign key anyway; this makes it a sentence, not a 500. */
      const template =
        version?.template ??
        (await db.whatsAppTemplate.findFirst({
          where: { id: templateId },
          select: { id: true, status: true },
        }));

      if (!template || template.status !== "APPROVED") return null;

      const created = await db.leadSource.create({
        data: {
          companyId,
          name: name.length > 0 ? name.slice(0, 120) : chosen.title.slice(0, 120),
          spreadsheetId: ref.spreadsheetId,
          tab: chosen.title,
          sheetGid: chosen.sheetId,
          action: actionKind,
          /* Mapped at the next step. Stored now so the row is complete and the
             CHECK constraint is satisfied by a real action from the start -
             and the constraint has two arms, so exactly one of the two columns
             below is set for each kind. */
          actionConfig:
            actionKind === "FLOW"
              ? {
                  kind: "FLOW",
                  flowVersionId: version!.id,
                  mapping: { phone: "", variables: {} },
                }
              : {
                  kind: "TEMPLATE",
                  templateId,
                  mapping: { phone: "", variables: {} },
                },
          ...(actionKind === "FLOW"
            ? { flowVersionId: version!.id }
            : { templateId }),
          whatsappNumberId,
          /* Not polling yet. An unmapped binding that started reading would
             reject every row for a missing phone column and fill its own
             report with the consequences of a step nobody has taken. */
          status: "PAUSED",
          pollIntervalSeconds: POLL_INTERVAL_DEFAULT_SECONDS,
          createdByUserId: session.userId,
        },
        select: { id: true },
      });

      return created.id;
    },
  );

  if (!leadSourceId) {
    return {
      message:
        "That template or flow is not available, or the number is not one of yours. A new lead has never written to you, so only an approved template can reach them - which is also what a flow opens with.",
      values,
    };
  }

  redirect(`/configuration/lead-sources/${leadSourceId}/map`);
}

/**
 * Step two: which column feeds the number, which feeds each placeholder, and
 * how often to look.
 *
 * Switching the binding on is the last thing this does, after the mapping is
 * complete and the scheduler is registered. The other order registers a poll
 * for a binding that is still unmapped.
 */
export async function mapLeadSourceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const leadSourceId = String(formData.get("leadSourceId") ?? "");
  if (!leadSourceId) return;

  const interval = clampPollInterval(
    Number(formData.get("pollIntervalSeconds") ?? POLL_INTERVAL_DEFAULT_SECONDS),
  );

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    const binding = await db.leadSource.findFirst({
      where: { id: leadSourceId },
      select: {
        id: true,
        spreadsheetId: true,
        tab: true,
        action: true,
        actionConfig: true,
        templateId: true,
        flowVersionId: true,
        template: { select: { components: true } },
        /* A FLOW binding's template is its version's entry template. The
           columns a sheet has to supply are that template's variables, so the
           mapping question is identical and only its source differs. */
        flowVersion: { select: { template: { select: { components: true } } } },
      },
    });

    if (!binding) return null;

    const components =
      binding.action === "FLOW"
        ? binding.flowVersion?.template.components
        : binding.template?.components;

    if (components === undefined || components === null) return null;

    const variableCount = templateVariables(extractBody(components)).length;

    const mapping: ColumnMapping = {
      phone: String(formData.get("phoneColumn") ?? ""),
      variables: Object.fromEntries(
        Array.from({ length: variableCount }, (_, i) => [
          String(i + 1),
          String(formData.get(`variable_${i + 1}`) ?? ""),
        ]),
      ),
    };

    /* An incomplete mapping is refused rather than filled with blanks. A
       message with a hole in it is one every lead gets wrong, for ever,
       unattended - which is worse here than in a bulk send somebody watched. */
    if (mappingGaps(mapping, variableCount).length > 0) return null;

    const tab = String(formData.get("tab") ?? "").trim();
    const currentTab = binding.tab;

    await db.leadSource.updateMany({
      where: { id: leadSourceId, companyId },
      data: {
        ...(tab ? { tab } : {}),
        /* Cast at the boundary: the shape is validated by
           leadSourceActionSchema on the way back out, and Prisma's Json input
           type does not accept a structurally-typed object. */
        actionConfig:
          binding.action === "FLOW"
            ? {
                kind: "FLOW",
                flowVersionId: binding.flowVersionId,
                mapping: { phone: mapping.phone, variables: mapping.variables },
              }
            : {
                kind: "TEMPLATE",
                templateId: binding.templateId,
                mapping: { phone: mapping.phone, variables: mapping.variables },
              },
        pollIntervalSeconds: interval,
        /*
         * The cursor is reset whenever the mapping changes, and this is a
         * decision rather than housekeeping.
         *
         * A remapped binding is a new intent, and the cursor it should start
         * from is where the sheet is NOW - which is what startingCursor below
         * establishes, after this transaction and from a live read. Zeroed here
         * only so that a failure between the two leaves a binding that reads
         * from the top rather than one that reads from a position belonging to
         * a mapping it no longer has.
         *
         * The stored hashes still protect anyone already contacted: a row whose
         * message is genuinely unchanged collides and is refused.
         */
        cursorCount: 0,
        cursorAnchor: null,
        status: "ACTIVE",
        lastError: null,
        lastErrorAt: null,
        backoffUntil: null,
      },
    });

    return {
      id: leadSourceId,
      spreadsheetId: binding.spreadsheetId,
      tab: tab || currentTab,
    };
  });

  if (!outcome) return;

  /*
   * Start from the END of the sheet, not the beginning.
   *
   * This is the decision most likely to be got wrong quietly, and it is wrong
   * in an expensive direction. A cursor left at zero means switching on a
   * binding contacts every row ALREADY in the spreadsheet - five thousand
   * customers who filled in a form eighteen months ago, all at once, from a
   * screen whose copy says "every new row becomes a lead". Nobody could
   * un-send that.
   *
   * So activation records where the sheet is now, and a lead source means what
   * it says: rows added from this moment. The backlog has its own tool - bulk
   * messaging, which shows the counts, asks for a typed confirmation and paces
   * the send. That is the screen a decision to contact five thousand people
   * deserves, and it already exists.
   *
   * Read here rather than carried in a hidden field, because a starting cursor
   * posted by a browser is one a browser can change - and the change nobody
   * would notice is the one that sets it back to zero.
   */
  const start = await startingCursor(
    session.companyId,
    outcome.spreadsheetId,
    outcome.tab,
  );

  await withCompany(session.companyId, (db, companyId) =>
    db.leadSource.updateMany({
      where: { id: leadSourceId, companyId },
      data: { cursorCount: start.count, cursorAnchor: start.anchor },
    }),
  );

  await scheduleLeadSourcePoll({
    companyId: session.companyId,
    leadSourceId,
    intervalSeconds: interval,
  });

  redirect(`/configuration/lead-sources/${leadSourceId}`);
}

/**
 * Switch a binding on or off.
 *
 * One UPDATE. The scheduler keeps ticking either way and the poll handler
 * returns early on a status that is not ACTIVE, so re-enabling cannot fail
 * half way and leave a binding that says ACTIVE and reads nothing - which is
 * the worst of the three states, because it looks correct.
 *
 * Enabling also clears the error, because the tenant has usually just fixed
 * the share and pressing this is how they say so. If it is still wrong the
 * next poll puts the error straight back, which is a truthful thirty seconds
 * rather than a stale sentence that outlives its cause.
 */
export async function setLeadSourceEnabledAction(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const leadSourceId = String(formData.get("leadSourceId") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!leadSourceId) return;

  await withCompany(session.companyId, (db, companyId) =>
    db.leadSource.updateMany({
      where: { id: leadSourceId, companyId },
      data: enabled
        ? {
            status: "ACTIVE",
            lastError: null,
            lastErrorAt: null,
            backoffUntil: null,
          }
        : { status: "PAUSED" },
    }),
  );

  /* The action stays on the page, so without this the badge keeps its old
     value until something else re-renders - which reads as "the button did
     not work" and gets pressed again. */
  revalidatePath(`/configuration/lead-sources/${leadSourceId}`);
  revalidatePath("/configuration/lead-sources");
}

/**
 * Delete a binding, and stop its poll.
 *
 * The scheduler is removed FIRST. A row deleted while its scheduler still runs
 * is a job that wakes every thirty seconds for ever and logs a not-found on
 * every tick; the other order leaves at worst a scheduler for a row that is
 * still there, which the next tick handles correctly.
 *
 * Deleting cascades to lead_source_rows, so the idempotency records go with
 * it - re-binding the same sheet will message everybody on it again. That is
 * the honest behaviour rather than an oversight, and the control says so
 * before it is pressed.
 */
export async function deleteLeadSourceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const leadSourceId = String(formData.get("leadSourceId") ?? "");
  if (!leadSourceId) return;

  await unscheduleLeadSourcePoll(leadSourceId);

  await withCompany(session.companyId, (db, companyId) =>
    db.leadSource.deleteMany({ where: { id: leadSourceId, companyId } }),
  );

  revalidatePath("/configuration/lead-sources");
  redirect("/configuration/lead-sources");
}

/**
 * Where the sheet is right now, so activation starts from its end.
 *
 * A failed read leaves the cursor at zero, which is the safe direction in the
 * only sense that matters here: the next poll re-reads the sheet, finds the
 * same rows, and every one of them is checked against the unique index before
 * anything is sent. What it costs is one pass over a sheet; what the other
 * direction would cost is a starting position nobody verified.
 */
async function startingCursor(
  companyId: string,
  spreadsheetId: string,
  tab: string,
): Promise<{ count: number; anchor: string | null }> {
  const secrets = await companyGoogleSecrets(companyId);
  if (!secrets) return { count: 0, anchor: null };

  const sheet = await readSheetValues(secrets, spreadsheetId, tab);
  if (!sheet.ok) return { count: 0, anchor: null };

  const rows = toRecords(sheet.rows).rows;

  return {
    count: rows.length,
    anchor: rows.length > 0 ? anchorHash(rows[rows.length - 1]!) : null,
  };
}

/**
 * What a failed access check says to the person who just pasted a URL.
 *
 * Google answers 404 for a spreadsheet that has not been shared, because to
 * this service account it genuinely does not exist. Passing that through as
 * "Requested entity was not found" is technically honest and useless: the
 * reader's next action is to share the sheet, and nothing in Google's sentence
 * suggests it.
 */
function shareFailureSentence(kind: string, error: string): string {
  if (kind === "config" || kind === "auth") {
    /* Deliberately says WHICH address rather than "the address above". This
       sentence is stored on the binding and rendered again on its own page,
       where there is nothing above it - a screenshot caught exactly that. */
    return `We cannot see that spreadsheet. Share it with the service account, as Editor, then try again. (Google said: ${error})`;
  }

  return `Google did not answer just now, so we could not check the sheet. Try again in a moment. (${error})`;
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
