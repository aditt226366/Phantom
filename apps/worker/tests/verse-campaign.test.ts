import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The campaign engine, which is the thing that aims Verse at real people.
 *
 * Four of its checks fail silently when they regress, and each one is somebody
 * different's problem:
 *
 *   the template   Meta revoked approval and every send is now refused one at
 *                  a time, while the campaign reports itself as running
 *   the window     it is 2am for the tenant's customers
 *   the cap        today's allowance is spent
 *   the driver     the contact is already mid-conversation with somebody else
 *
 * The template one is the least obvious and the most damaging: nothing throws,
 * the campaign keeps ticking, and the tenant finds out from their delivery
 * numbers days later.
 */

interface Campaign {
  id: string;
  name: string;
  status: string;
  timezone: string;
  startAt: Date | null;
  dailyWindowStartMinute: number | null;
  dailyWindowEndMinute: number | null;
  dailyCap: number | null;
  whatsappNumberId: string | null;
  template: {
    id: string;
    name: string;
    language: string;
    status: string;
    components: unknown;
  };
}

let campaign: Campaign | null = null;
let sentToday = 0;
let pending: Array<{
  id: string;
  phoneE164: string;
  variables: unknown;
  contactId: string | null;
}> = [];
let claimResult: Record<string, unknown> = {
  kind: "claimed",
  displaced: "NOBODY",
  displacedRef: null,
};
let produced: Record<string, unknown> | null = {
  contactId: "contact-1",
  conversationId: "conv-1",
  messageId: "msg-1",
  sendAttempt: 0,
};

const findFirstCampaign = vi.fn(async (_args: unknown) => campaign);
const updateManyCampaign = vi.fn(async (_args: unknown) => ({ count: 1 }));
const updateManyRecipient = vi.fn(async (_args: unknown) => ({ count: 1 }));

const campaignSentSince = vi.fn(
  async (_db: unknown, _c: string, _id: string, _since: Date) => sentToday,
);
const nextCampaignRecipients = vi.fn(
  async (_db: unknown, _c: string, _id: string, _take: number) => pending,
);
const stopCampaignForTemplate = vi.fn(
  async (_db: unknown, _c: string, _id: string, _reason: string) => true,
);
const materialiseOutboundTemplate = vi.fn(
  async (_db: unknown, _c: string, _input: unknown) => produced,
);
const claimDriver = vi.fn(
  async (_db: unknown, _c: string, _conv: string, _input: unknown) => claimResult,
);

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn(
      {
        verseCampaign: {
          findFirst: findFirstCampaign,
          updateMany: updateManyCampaign,
        },
        verseCampaignRecipient: { updateMany: updateManyRecipient },
      },
      companyId,
    ),
  campaignSentSince,
  nextCampaignRecipients,
  stopCampaignForTemplate,
  materialiseOutboundTemplate,
  claimDriver,
}));

const queueAdd = vi.fn(async () => ({}));
vi.mock("../src/queue.ts", () => ({ systemQueue: { add: queueAdd } }));

const { handleVerseCampaignTick } = await import("../src/jobs/verse-campaign.ts");

const JOB = { companyId: "co-1", campaignId: "camp-1" };

/** 09:00 UTC is 14:30 IST — inside a 09:00-20:00 window. */
const MIDDAY_IST = new Date("2026-09-02T09:00:00Z");
/** 20:00 UTC is 01:30 IST the next day — outside it. */
const NIGHT_IST = new Date("2026-09-02T20:00:00Z");

function baseCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp-1",
    name: "Winter push",
    status: "RUNNING",
    timezone: "Asia/Kolkata",
    startAt: null,
    dailyWindowStartMinute: 9 * 60,
    dailyWindowEndMinute: 20 * 60,
    dailyCap: null,
    whatsappNumberId: "num-1",
    template: {
      id: "tpl-1",
      name: "winter_open",
      language: "en_US",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(MIDDAY_IST);
  campaign = baseCampaign();
  sentToday = 0;
  pending = [
    { id: "r1", phoneE164: "+919000000001", variables: ["Asha"], contactId: null },
  ];
  claimResult = { kind: "claimed", displaced: "NOBODY", displacedRef: null };
  produced = {
    contactId: "contact-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    sendAttempt: 0,
  };
});

describe("the happy path", () => {
  it("contacts a pending recipient through the shared producer", async () => {
    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).toHaveBeenCalledTimes(1);
    /* The one send path. A campaign is a producer of messages, not a second
       way to send them - Phase 5's rule, inherited rather than restated. */
    expect(queueAdd).toHaveBeenCalledTimes(1);

    const [, , input] = materialiseOutboundTemplate.mock.calls[0]!;
    expect((input as { whatsappNumberId: string }).whatsappNumberId).toBe("num-1");
  });

  it("marks the recipient SENT with the message it produced", async () => {
    await handleVerseCampaignTick(JOB);

    const call = updateManyRecipient.mock.calls.at(-1)![0] as {
      data: { status: string; messageId: string };
    };
    expect(call.data.status).toBe("SENT");
    expect(call.data.messageId).toBe("msg-1");
  });

  it("completes when nothing is left to contact", async () => {
    pending = [];

    await handleVerseCampaignTick(JOB);

    const call = updateManyCampaign.mock.calls.at(-1)![0] as {
      data: { status: string };
    };
    expect(call.data.status).toBe("COMPLETED");
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("the template Meta revoked mid-flight", () => {
  it.each(["REJECTED", "PAUSED", "DISABLED"])(
    "stops the campaign when the template is %s",
    async (status) => {
      /*
       * The failure with no symptom. Unchecked, every remaining send is
       * refused by the Graph API one message at a time - a failed bubble in a
       * real customer's thread each time - while the campaign reports itself
       * as running normally.
       */
      campaign = baseCampaign({
        template: { ...baseCampaign().template, status },
      });

      await handleVerseCampaignTick(JOB);

      expect(stopCampaignForTemplate).toHaveBeenCalledTimes(1);
      expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    },
  );

  it("records a reason an operator can act on", async () => {
    campaign = baseCampaign({
      template: { ...baseCampaign().template, status: "REJECTED" },
    });

    await handleVerseCampaignTick(JOB);

    const [, , , reason] = stopCampaignForTemplate.mock.calls[0]!;
    expect(reason).toMatch(/rejected/i);
    /* Names what to do next, not just what happened. */
    expect(reason.length).toBeGreaterThan(40);
  });

  it("checks the template every tick, not once at start", async () => {
    /* The revocation happens WHILE a campaign runs. A check at start would
       pass for ever on a campaign that can no longer send anything. */
    campaign = baseCampaign();
    await handleVerseCampaignTick(JOB);
    expect(materialiseOutboundTemplate).toHaveBeenCalledTimes(1);

    campaign = baseCampaign({
      template: { ...baseCampaign().template, status: "PAUSED" },
    });
    await handleVerseCampaignTick(JOB);
    expect(stopCampaignForTemplate).toHaveBeenCalledTimes(1);
  });

  it("keeps running on APPROVED", async () => {
    await handleVerseCampaignTick(JOB);
    expect(stopCampaignForTemplate).not.toHaveBeenCalled();
  });
});

describe("the daily send window", () => {
  it("contacts nobody at 2am in the tenant's timezone", async () => {
    /*
     * The product failure this exists for: a phone buzzing at two in the
     * morning, which costs the tenant a customer and possibly a complaint to
     * Meta about their number.
     */
    vi.setSystemTime(NIGHT_IST);

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("does not even read the recipient list when it is holding", async () => {
    /* Holding is the common case overnight, and it should be cheap. */
    vi.setSystemTime(NIGHT_IST);

    await handleVerseCampaignTick(JOB);

    expect(nextCampaignRecipients).not.toHaveBeenCalled();
  });

  it("sends when there is no window at all", async () => {
    campaign = baseCampaign({
      dailyWindowStartMinute: null,
      dailyWindowEndMinute: null,
    });
    vi.setSystemTime(NIGHT_IST);

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("the daily cap", () => {
  it("contacts nobody once the cap is spent", async () => {
    campaign = baseCampaign({ dailyCap: 50 });
    sentToday = 50;

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
  });

  it("asks for only the remaining allowance, not a full batch", async () => {
    /*
     * Applied as a LIMIT rather than by fetching everybody and stopping. At
     * ten thousand recipients that is ten thousand rows read to send three.
     */
    campaign = baseCampaign({ dailyCap: 50 });
    sentToday = 47;

    await handleVerseCampaignTick(JOB);

    const [, , , take] = nextCampaignRecipients.mock.calls[0]!;
    expect(take).toBe(3);
  });

  it("sends without limit when no cap is set", async () => {
    sentToday = 100_000;

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("the driver", () => {
  it("claims the conversation before the message goes out", async () => {
    await handleVerseCampaignTick(JOB);

    expect(claimDriver).toHaveBeenCalledTimes(1);
    const [, , , input] = claimDriver.mock.calls[0]!;
    expect(input).toMatchObject({ driver: "VERSE", ref: "camp-1" });
  });

  it("skips a contact another automation is already talking to", async () => {
    /*
     * An automation never displaces another automation. Somebody already
     * mid-conversation is a poor candidate for a cold opener, so declining
     * loses nothing worth having - and the skip is recorded rather than two
     * automations writing into one thread on independent schedules.
     */
    claimResult = { kind: "refused", heldBy: "FLOW", heldRef: "run-7" };

    await handleVerseCampaignTick(JOB);

    const call = updateManyRecipient.mock.calls.at(-1)![0] as {
      data: { status: string; skipReason: string };
    };
    expect(call.data.status).toBe("SKIPPED");
    expect(call.data.skipReason).toMatch(/already in an automated conversation/i);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("says so differently when a person is handling it", async () => {
    claimResult = { kind: "refused", heldBy: "OPERATOR", heldRef: "user-1" };

    await handleVerseCampaignTick(JOB);

    const call = updateManyRecipient.mock.calls.at(-1)![0] as {
      data: { skipReason: string };
    };
    expect(call.data.skipReason).toMatch(/someone from your team/i);
  });
});

describe("recipients who must not be messaged", () => {
  it("skips an opted-out contact with a reason", async () => {
    /*
     * materialiseOutboundTemplate returns null at the last opt-out filter. A
     * skip with its cause rather than a silent drop - "not contacted" with no
     * reason is the state people escalate.
     */
    produced = null;

    await handleVerseCampaignTick(JOB);

    const call = updateManyRecipient.mock.calls.at(-1)![0] as {
      data: { status: string; skipReason: string };
    };
    expect(call.data.status).toBe("SKIPPED");
    expect(call.data.skipReason).toMatch(/opted out|undeliverable/i);
    expect(claimDriver).not.toHaveBeenCalled();
  });
});

describe("statuses that do nothing", () => {
  it.each(["PAUSED", "STOPPED", "DRAFT", "COMPLETED", "ARCHIVED"])(
    "ticks and does nothing when %s",
    async (status) => {
      /*
       * Paused campaigns keep their scheduler rather than being unregistered:
       * resuming is then one UPDATE instead of a re-registration that could
       * fail and leave a campaign saying RUNNING while nothing ticks it.
       */
      campaign = baseCampaign({ status });

      await handleVerseCampaignTick(JOB);

      expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
      expect(stopCampaignForTemplate).not.toHaveBeenCalled();
    },
  );

  it("waits for a scheduled start time", async () => {
    campaign = baseCampaign({
      startAt: new Date(MIDDAY_IST.getTime() + 3_600_000),
    });

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
  });

  it("refuses to send when a running campaign has no number", async () => {
    /* A CHECK should make this impossible. Stopping quietly beats sending
       from nowhere if one ever slips past. */
    campaign = baseCampaign({ whatsappNumberId: null });

    await handleVerseCampaignTick(JOB);

    expect(materialiseOutboundTemplate).not.toHaveBeenCalled();
  });
});
