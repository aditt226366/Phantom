"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  JOB_NAMES,
  verseCampaignSchedulerId,
} from "@whatsapp-os/core/queues";
import { buildAudience, rejectSentence } from "@whatsapp-os/core/bulk";
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

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    /*
     * An empty audience is refused here rather than discovered by the engine.
     *
     * The tick treats "no pending recipients" as finished and writes
     * COMPLETED - which is correct for a campaign that has contacted everyone
     * and completely wrong for one that has contacted nobody. Started with an
     * empty list it would go RUNNING and then COMPLETED within a minute, and
     * read on the list as a campaign that ran.
     */
    const pending = await db.verseCampaignRecipient.count({
      where: { companyId, campaignId, status: "PENDING" },
    });

    if (pending === 0) return "empty" as const;

    const { count } = await db.verseCampaign.updateMany({
      where: {
        id: campaignId,
        companyId,
        status: { in: ["DRAFT", "SCHEDULED"] },
        /* A campaign with no number cannot run, and the CHECK would refuse the
           write anyway - this turns a constraint violation into a sentence. */
        whatsappNumberId: { not: null },
      },
      data: { status: "RUNNING" },
    });

    return count === 0 ? ("blocked" as const) : ("started" as const);
  });

  if (outcome === "empty") {
    return {
      error:
        "This campaign has nobody to contact yet. Add an audience first — a " +
        "campaign with an empty list would start and finish without messaging " +
        "anyone.",
    };
  }

  if (outcome === "blocked") {
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

/* ------------------------------------------------------------------------- *
 * The audience
 * ------------------------------------------------------------------------- */

/**
 * Import who this campaign will contact.
 *
 * ---------------------------------------------------------------------------
 * The same audience builder bulk messaging uses, not a second one
 * ---------------------------------------------------------------------------
 *
 * `buildAudience` already parses phone numbers, rejects the unparseable, drops
 * duplicates and puts the template's variables into Meta's positional order.
 * A second copy here would be one edit away from disagreeing about any of
 * those - and the one that matters is the positional order, where getting it
 * wrong puts the order number where the customer's name goes.
 *
 * Phase 5 established that bulk is a producer of messages rather than a second
 * send path. This is the same argument one level up: a campaign is a second
 * producer of an AUDIENCE, and it reuses the builder rather than restating it.
 *
 * ---------------------------------------------------------------------------
 * Recipients are rows, not messages
 * ---------------------------------------------------------------------------
 *
 * They land as PENDING in verse_campaign_recipients and become messages only
 * when the engine reaches them, on the campaign's schedule and against its
 * cap. Putting un-sent intent into `messages` would need a pre-send member on
 * message_status - a state describing rows that are not messages yet, in the
 * one enum every delivery callback reasons about. Phase 5 refused that for
 * broadcasts and this refuses it for the same reason.
 */
export async function importAudienceAction(
  _state: CampaignState,
  formData: FormData,
): Promise<CampaignState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const campaignId = String(formData.get("campaignId") ?? "");
  const pasted = String(formData.get("numbers") ?? "").trim();

  if (pasted.length === 0) {
    return { error: "Paste at least one phone number." };
  }

  /*
   * One number per line, with optional comma-separated template variables.
   *
   * Deliberately simpler than bulk's CSV upload with its column-mapping
   * screen. A campaign's audience is typically a list somebody already has in
   * a spreadsheet column, and asking them to map columns for a single required
   * field would be three screens to collect one. The mapping machinery stays
   * available for the day a campaign needs a wide CSV.
   */
  const rows = pasted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [phone, ...variables] = line.split(",").map((cell) => cell.trim());
      const record: Record<string, string> = { phone: phone ?? "" };
      variables.forEach((value, index) => {
        record[String(index + 1)] = value;
      });
      return record;
    });

  const variablePositions: Record<string, string> = {};
  const widest = rows.reduce(
    (most, row) => Math.max(most, Object.keys(row).length - 1),
    0,
  );
  for (let position = 1; position <= widest; position += 1) {
    variablePositions[String(position)] = String(position);
  }

  const audience = buildAudience(rows, {
    phone: "phone",
    variables: variablePositions,
  });

  if (audience.recipients.length === 0) {
    return {
      error:
        audience.rejects.length > 0
          ? `None of those could be used. The first problem: ${rejectSentence(
              audience.rejects[0]!.reason,
            )}`
          : "No usable phone numbers in that list.",
    };
  }

  const added = await withCompany(session.companyId, async (db, companyId) => {
    const campaign = await db.verseCampaign.findFirst({
      where: { id: campaignId },
      select: { id: true },
    });

    if (!campaign) return null;

    /*
     * skipDuplicates, against the unique on (company, campaign, phone).
     *
     * Pasting an overlapping list twice must not queue somebody twice, and a
     * check-then-insert would lose that race to a second submission. The index
     * is the deduplication, exactly as it is for lead-source rows.
     */
    const { count } = await db.verseCampaignRecipient.createMany({
      data: audience.recipients.map((recipient) => ({
        companyId,
        campaignId: campaign.id,
        phoneE164: recipient.phoneE164,
        variables: recipient.variables,
        status: "PENDING" as const,
      })),
      skipDuplicates: true,
    });

    return count;
  });

  if (added === null) return { error: "That campaign could not be found." };

  revalidatePath(`/ai-messaging/${campaignId}`);
  return {};
}
