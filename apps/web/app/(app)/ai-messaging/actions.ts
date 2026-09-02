"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  JOB_NAMES,
  verseCampaignSchedulerId,
} from "@whatsapp-os/core/queues";
import { VERSE_TIERS, parseMinutes } from "@whatsapp-os/core/verse";
import { withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { systemQueue } from "@/lib/queue";

/**
 * Creating a campaign, and the four controls it has afterwards.
 *
 * Every action calls requireSession() and assertFeatureAccess() itself. Rule 4:
 * the layout's check is a redirect for the user's benefit, and a server action
 * is reachable by its id whatever the page rendered.
 */

export interface CampaignState {
  error?: string;
}

/** How often a running campaign is asked whether it may send. */
const TICK_MS = 60_000;

/**
 * Register the per-campaign scheduler.
 *
 * ---------------------------------------------------------------------------
 * Derived from the campaign id, because upsertJobScheduler is an upsert
 * ---------------------------------------------------------------------------
 *
 * Editing a campaign re-registers under the same key and REPLACES the
 * schedule. A random or timestamped id would leave the old one running, and the
 * campaign would send at twice its intended pace - against a daily cap each
 * scheduler reads independently, so the cap would not save it either.
 *
 * The same argument leadSourceSchedulerId and dashboardRollupSchedulerId
 * already make. This is the fourth.
 */
async function registerTick(companyId: string, campaignId: string) {
  await systemQueue.upsertJobScheduler(
    verseCampaignSchedulerId(campaignId),
    { every: TICK_MS },
    {
      name: JOB_NAMES.VERSE_CAMPAIGN_TICK,
      data: { companyId, campaignId },
    },
  );
}

export async function createCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const name = String(formData.get("name") ?? "").trim();
  const goal = String(formData.get("goal") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "");
  const knowledgeBaseId = String(formData.get("knowledgeBaseId") ?? "");
  const whatsappNumberId = String(formData.get("whatsappNumberId") ?? "");
  const modelTier = String(formData.get("modelTier") ?? "");
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (name.length === 0) return { error: "Give the campaign a name." };
  if (goal.length === 0) {
    return {
      error:
        "Say what this campaign is for. Verse is told this verbatim, so write " +
        "it as an instruction to a colleague.",
    };
  }
  if (!templateId) return { error: "Choose the template that opens the conversation." };
  if (!knowledgeBaseId) return { error: "Choose a knowledge base to answer from." };
  if (!whatsappNumberId) return { error: "Choose the number to send from." };
  if (!(VERSE_TIERS as readonly string[]).includes(modelTier)) {
    return { error: "Choose a model." };
  }

  /*
   * The zone is validated by asking Intl rather than by matching a list. A
   * stored zone the runtime cannot resolve would throw inside the campaign
   * worker on every tick, where nobody is watching, rather than here where
   * somebody is.
   */
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date());
  } catch {
    return { error: "That is not a timezone this server recognises." };
  }

  const windowStart = optionalMinutes(formData.get("windowStart"));
  const windowEnd = optionalMinutes(formData.get("windowEnd"));

  if (windowStart === "bad" || windowEnd === "bad") {
    return { error: "A send window needs times like 09:00 and 20:00." };
  }

  /* Both ends or neither. A start with no end is a window that never closes,
     which is the thing the window exists to prevent. */
  if ((windowStart === null) !== (windowEnd === null)) {
    return { error: "Set both ends of the send window, or neither." };
  }

  if (windowStart !== null && windowEnd !== null && windowStart >= windowEnd) {
    return {
      error:
        "The send window has to start before it ends. A window that wraps " +
        "past midnight is a window that messages people at 2am.",
    };
  }

  const capRaw = String(formData.get("dailyCap") ?? "").trim();
  const dailyCap = capRaw === "" ? null : Number(capRaw);

  if (dailyCap !== null && (!Number.isInteger(dailyCap) || dailyCap <= 0)) {
    return { error: "A daily cap has to be a whole number above zero." };
  }

  const campaign = await withCompany(session.companyId, async (db, companyId) => {
    /* Every reference must be this company's. Rule 6 - anything else does not
       exist, so a bad id is "not found" and never a 403. */
    const [template, base, number] = await Promise.all([
      db.whatsAppTemplate.findFirst({
        where: { id: templateId },
        select: { id: true },
      }),
      db.knowledgeBase.findFirst({
        where: { id: knowledgeBaseId },
        select: { id: true },
      }),
      db.whatsAppNumber.findFirst({
        where: { id: whatsappNumberId },
        select: { id: true },
      }),
    ]);

    if (!template || !base || !number) return null;

    return db.verseCampaign.create({
      data: {
        companyId,
        name,
        goal,
        templateId: template.id,
        knowledgeBaseId: base.id,
        whatsappNumberId: number.id,
        modelTier,
        timezone,
        dailyWindowStartMinute: windowStart,
        dailyWindowEndMinute: windowEnd,
        dailyCap,
        status: "DRAFT",
      },
      select: { id: true },
    });
  });

  if (!campaign) {
    return { error: "One of those choices could not be found." };
  }

  redirect(`/ai-messaging/${campaign.id}`);
}

/** "09:00" to 540, "" to null, anything else to "bad". */
function optionalMinutes(value: FormDataEntryValue | null): number | null | "bad" {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const minutes = parseMinutes(raw);
  return minutes === null ? "bad" : minutes;
}

/* ------------------------------------------------------------------------- *
 * The lifecycle
 * ------------------------------------------------------------------------- */

/**
 * Start it, and register the scheduler that makes it tick.
 *
 * The scheduler carries the companyId, which is the third trusted origin in
 * rule 3 - it is there because this action put it there after requireSession().
 */
export async function startCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");

  const { count } = await withCompany(session.companyId, (db, companyId) =>
    db.verseCampaign.updateMany({
      where: {
        id: campaignId,
        companyId,
        status: { in: ["DRAFT", "SCHEDULED"] },
        /* A campaign with no number cannot run, and the CHECK would refuse the
           write anyway - this turns a constraint violation into a sentence. */
        whatsappNumberId: { not: null },
      },
      data: { status: "RUNNING" },
    }),
  );

  if (count === 0) {
    return {
      error: "That campaign cannot be started — check it has a number to send from.",
    };
  }

  await registerTick(session.companyId, campaignId);

  revalidatePath("/ai-messaging");
  revalidatePath(`/ai-messaging/${campaignId}`);
  return {};
}

/**
 * Pause it. The scheduler stays registered.
 *
 * The handler returns early on any status but RUNNING, so resuming is one
 * UPDATE rather than a re-registration that could fail and leave a campaign
 * saying RUNNING while nothing ticks it. The same decision the lead-source
 * poller made, and for the same reason.
 */
export async function pauseCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");

  await withCompany(session.companyId, (db, companyId) =>
    db.verseCampaign.updateMany({
      where: { id: campaignId, companyId, status: "RUNNING" },
      data: { status: "PAUSED" },
    }),
  );

  revalidatePath("/ai-messaging");
  revalidatePath(`/ai-messaging/${campaignId}`);
  return {};
}

export async function resumeCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");

  await withCompany(session.companyId, (db, companyId) =>
    db.verseCampaign.updateMany({
      where: { id: campaignId, companyId, status: "PAUSED" },
      data: { status: "RUNNING" },
    }),
  );

  /*
   * Re-registered anyway, and it is an upsert so this is free.
   *
   * A campaign paused for long enough that BullMQ dropped its scheduler would
   * otherwise resume into silence - RUNNING, with nothing ticking it. Doing it
   * unconditionally costs one idempotent call and removes a state nobody could
   * diagnose from the UI.
   */
  await registerTick(session.companyId, campaignId);

  revalidatePath("/ai-messaging");
  revalidatePath(`/ai-messaging/${campaignId}`);
  return {};
}

/**
 * Copy a campaign back to DRAFT, without its audience or its history.
 *
 * The audience is deliberately not copied. Duplicating a campaign is how
 * somebody starts again after Meta rejected a template, or runs the same
 * approach at a different list - and silently re-contacting the first
 * campaign's recipients is the one outcome nobody wants from a button labelled
 * Duplicate.
 */
export async function duplicateCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");

  const copy = await withCompany(session.companyId, async (db, companyId) => {
    const source = await db.verseCampaign.findFirst({
      where: { id: campaignId },
      select: {
        name: true,
        goal: true,
        templateId: true,
        knowledgeBaseId: true,
        whatsappNumberId: true,
        modelTier: true,
        timezone: true,
        dailyWindowStartMinute: true,
        dailyWindowEndMinute: true,
        dailyCap: true,
      },
    });

    if (!source) return null;

    return db.verseCampaign.create({
      data: {
        ...source,
        companyId,
        name: `${source.name} (copy)`,
        status: "DRAFT",
        /* Not copied: stoppedReason. A copy has not been stopped, and carrying
           the original's reason would show a rejection that is not this
           campaign's. */
        stoppedReason: null,
      },
      select: { id: true },
    });
  });

  if (!copy) return { error: "That campaign could not be found." };

  redirect(`/ai-messaging/${copy.id}`);
}

/**
 * Archive it, and remove the scheduler.
 *
 * Archived rather than deleted: a campaign that contacted people is the record
 * of who was messaged and what they were told, and the conversations it opened
 * outlive it.
 *
 * The scheduler IS removed here, unlike on pause - an archived campaign is not
 * coming back, and a job that wakes every minute for ever to find nothing is
 * the state leadSourceSchedulerId's comment warns about.
 */
export async function archiveCampaignAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");

  const { count } = await withCompany(session.companyId, (db, companyId) =>
    db.verseCampaign.updateMany({
      where: { id: campaignId, companyId, status: { not: "RUNNING" } },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    }),
  );

  if (count === 0) {
    return { error: "Pause the campaign before archiving it." };
  }

  await systemQueue
    .removeJobScheduler(verseCampaignSchedulerId(campaignId))
    .catch(() => undefined);

  revalidatePath("/ai-messaging");
  revalidatePath(`/ai-messaging/${campaignId}`);
  return {};
}
