import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  sendJobId,
  type VerseCampaignTickJob,
} from "@whatsapp-os/core/queues";
import { fillVariables } from "@whatsapp-os/core/whatsapp";
import {
  maySend,
  templateStopReason,
  templateStopsCampaign,
} from "@whatsapp-os/core/verse";
import {
  campaignSentSince,
  claimDriver,
  materialiseOutboundTemplate,
  nextCampaignRecipients,
  stopCampaignForTemplate,
  withCompany,
} from "@whatsapp-os/db";
import { log } from "../logger.ts";
import { systemQueue } from "../queue.ts";

/**
 * One tick of a running campaign: contact the next few people, or explain why
 * it did not.
 *
 * ---------------------------------------------------------------------------
 * This is the only thing that opens a conversation, and the only thing that
 * REopens one
 * ---------------------------------------------------------------------------
 *
 * The reply path deliberately refuses to send a template when a window has
 * lapsed - the campaign's approved template is an OPENER, and firing it at
 * somebody mid-conversation restarts the conversation rather than continuing
 * it. Re-opening belongs here instead, where it happens on the campaign's own
 * schedule and against its own daily cap.
 *
 * That split is the whole reason a lapsed conversation is not simply reopened
 * the moment the customer's next message arrives: the customer's message is
 * not what should decide that a business messages them again.
 *
 * ---------------------------------------------------------------------------
 * The checks, in order, and each one is a different person's problem
 * ---------------------------------------------------------------------------
 *
 *   the template   Meta may have revoked approval since the last tick
 *   the window     it may be 2am for the tenant
 *   the cap        today's allowance may be spent
 *   the driver     the contact may already be mid-conversation with somebody
 */
export async function handleVerseCampaignTick(
  job: VerseCampaignTickJob,
): Promise<void> {
  const { companyId, campaignId } = job;
  const now = new Date();

  const campaign = await withCompany(companyId, (db) =>
    db.verseCampaign.findFirst({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        status: true,
        timezone: true,
        startAt: true,
        dailyWindowStartMinute: true,
        dailyWindowEndMinute: true,
        dailyCap: true,
        whatsappNumberId: true,
        template: {
          select: {
            id: true,
            name: true,
            language: true,
            status: true,
            components: true,
          },
        },
      },
    }),
  );

  if (!campaign) return;

  /*
   * Paused and stopped campaigns tick and do nothing, rather than being
   * unregistered. The same argument the lead-source poller makes: re-enabling
   * is then one UPDATE instead of a re-registration that could fail and leave
   * a campaign saying RUNNING while nothing polls it.
   */
  if (campaign.status !== "RUNNING") return;

  if (campaign.startAt && campaign.startAt > now) return;

  /* ---------------------------------------------------------------------- *
   * The template, which Meta can revoke mid-flight
   * ---------------------------------------------------------------------- */

  if (templateStopsCampaign(campaign.template.status)) {
    /*
     * Checked every tick rather than once at start, because the revocation
     * happens WHILE a campaign is running - that is the entire failure mode.
     * Unchecked, every remaining send is refused by the Graph API one message
     * at a time, each one a failed bubble in a real customer's thread, while
     * the campaign reports itself as running normally.
     */
    const stopped = await withCompany(companyId, (db, scoped) =>
      stopCampaignForTemplate(
        db,
        scoped,
        campaignId,
        templateStopReason(campaign.template.status),
      ),
    );

    if (stopped) {
      log.warn("verse.campaign: stopped, template no longer sendable", {
        campaignId,
        template: campaign.template.name,
        status: campaign.template.status,
      });
    }
    return;
  }

  /* ---------------------------------------------------------------------- *
   * The tenant's day
   * ---------------------------------------------------------------------- */

  const dayStart = startOfLocalDay(now, campaign.timezone);
  const sentToday = await withCompany(companyId, (db, scoped) =>
    campaignSentSince(db, scoped, campaignId, dayStart),
  );

  const verdict = maySend(
    {
      timezone: campaign.timezone,
      windowStartMinute: campaign.dailyWindowStartMinute,
      windowEndMinute: campaign.dailyWindowEndMinute,
      dailyCap: campaign.dailyCap,
    },
    sentToday,
    now,
  );

  if (verdict.kind !== "send") {
    log.info("verse.campaign: holding", {
      campaignId,
      reason: verdict.kind,
      ...(verdict.kind === "outside_window"
        ? { resumesInMinutes: verdict.resumesInMinutes }
        : { cap: verdict.cap }),
    });
    return;
  }

  const remaining =
    campaign.dailyCap === null
      ? BATCH
      : Math.min(BATCH, campaign.dailyCap - sentToday);

  if (remaining <= 0) return;

  /*
   * A RUNNING campaign always has a number - a CHECK says so - but the column
   * is nullable for the DRAFT case, so the type is narrowed here rather than
   * asserted away. If it is ever null the campaign is in a state the CHECK
   * should have refused, and stopping quietly beats sending from nowhere.
   */
  const whatsappNumberId = campaign.whatsappNumberId;
  if (!whatsappNumberId) {
    log.warn("verse.campaign: running with no number", { campaignId });
    return;
  }

  const recipients = await withCompany(companyId, (db, scoped) =>
    nextCampaignRecipients(db, scoped, campaignId, remaining),
  );

  if (recipients.length === 0) {
    await withCompany(companyId, (db) =>
      db.verseCampaign.updateMany({
        where: { id: campaignId, companyId },
        data: { status: "COMPLETED" },
      }),
    );
    log.info("verse.campaign: completed", { campaignId });
    return;
  }

  /* ---------------------------------------------------------------------- *
   * Contact them, through the one producer
   * ---------------------------------------------------------------------- */

  for (const recipient of recipients) {
    await contactOne(
      companyId,
      { ...campaign, whatsappNumberId },
      recipient,
      now,
    );
  }
}

/** How many to contact per tick, whatever the cap allows. */
const BATCH = 25;

function startOfLocalDay(now: Date, timezone: string): Date {
  /*
   * Midnight in the tenant's zone, as an instant.
   *
   * Derived by subtracting the local minutes elapsed rather than by parsing a
   * formatted date back, which is the version that goes wrong across a DST
   * transition: on the day a zone loses an hour, "today at 00:00" formatted
   * and re-parsed is an instant that does not exist.
   */
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const elapsed =
    (value("hour") % 24) * 3_600_000 +
    value("minute") * 60_000 +
    value("second") * 1_000;

  return new Date(now.getTime() - elapsed);
}

async function contactOne(
  companyId: string,
  campaign: {
    id: string;
    whatsappNumberId: string;
    template: { name: string; language: string; components: unknown };
  },
  recipient: {
    id: string;
    phoneE164: string;
    variables: unknown;
    contactId: string | null;
  },
  now: Date,
): Promise<void> {
  const variables = Array.isArray(recipient.variables)
    ? (recipient.variables as string[])
    : [];

  const outcome = await withCompany(companyId, async (db, scoped) => {
    const produced = await materialiseOutboundTemplate(db, scoped, {
      whatsappNumberId: campaign.whatsappNumberId,
      phoneE164: recipient.phoneE164,
      variables,
      template: {
        name: campaign.template.name,
        language: campaign.template.language,
      },
      renderedBody: fillVariables(
        bodyTextOf(campaign.template.components),
        variables,
      ),
      occurredAt: now,
      createdByUserId: null,
    });

    if (!produced) {
      /*
       * Opted out or undeliverable, filtered at the last moment by the shared
       * producer. A skip with its reason rather than a silent drop - "not
       * contacted" with no cause is the state people escalate.
       */
      await db.verseCampaignRecipient.updateMany({
        where: { id: recipient.id, companyId: scoped },
        data: {
          status: "SKIPPED",
          skipReason:
            "This contact has opted out or their number was reported " +
            "undeliverable, so they were not messaged.",
        },
      });
      return null;
    }

    /*
     * The driver, claimed before the message goes out.
     *
     * An automation never displaces another automation, so a contact already
     * mid-conversation with a flow - or with another campaign - is skipped
     * rather than talked over. Refusing is the correct outcome: somebody
     * already in a conversation is a poor candidate for a cold opener, and the
     * skip is recorded with its reason instead of two automations writing into
     * one thread on independent schedules.
     */
    const claim = await claimDriver(db, scoped, produced.conversationId, {
      driver: "VERSE",
      ref: campaign.id,
      at: now,
    });

    if (claim.kind === "refused") {
      await db.verseCampaignRecipient.updateMany({
        where: { id: recipient.id, companyId: scoped },
        data: {
          status: "SKIPPED",
          skipReason:
            claim.heldBy === "OPERATOR"
              ? "Someone from your team is already handling this conversation."
              : "This contact is already in an automated conversation, so " +
                "this campaign did not interrupt it.",
        },
      });
      return null;
    }

    await db.verseCampaignRecipient.updateMany({
      where: { id: recipient.id, companyId: scoped },
      data: {
        status: "SENT",
        messageId: produced.messageId,
        conversationId: produced.conversationId,
        contactId: produced.contactId,
      },
    });

    return produced;
  });

  if (!outcome) return;

  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    {
      companyId,
      messageId: outcome.messageId,
      sendAttempt: outcome.sendAttempt,
    },
    {
      ...SEND_JOB_OPTIONS,
      jobId: sendJobId(outcome.messageId, outcome.sendAttempt),
    },
  );
}

/** The BODY component's text, for the thread's preview. */
function bodyTextOf(components: unknown): string {
  if (!Array.isArray(components)) return "";

  const body = components.find(
    (component): component is { type?: string; text?: string } =>
      typeof component === "object" &&
      component !== null &&
      (component as { type?: string }).type === "BODY",
  );

  return body?.text ?? "";
}
