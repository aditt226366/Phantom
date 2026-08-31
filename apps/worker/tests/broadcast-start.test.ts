import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduling a broadcast, which is where the pacing actually happens.
 *
 * Three failures here would be silent and each reaches real people:
 *
 *   1. Every delay the same, or zero. The whole list goes out in one burst,
 *      Meta rate limits the number, and the quality rating takes the damage.
 *      Nothing errors - the sends all succeed, very fast.
 *   2. A resume restarting the schedule at zero. Same burst, and it happens
 *      precisely when somebody paused a run because something looked wrong.
 *   3. A recipient who opted out since the import getting a message. No error,
 *      and the first anybody knows is a complaint.
 */

/**
 * Every mock is typed to the signature it stands in for.
 *
 * vi.fn with a zero-argument implementation infers its call tuple as [], so
 * `add.mock.calls[0][2]` is an index into an empty tuple - it runs perfectly
 * and fails to typecheck, which is recorded in the conventions file and was
 * hit again writing this. The delay assertions below are the whole point of
 * the file, so the type has to carry the options argument.
 */
type JobOptions = { jobId: string; delay: number };

const add =
  vi.fn<(name: string, data: unknown, options: JobOptions) => Promise<unknown>>();
vi.mock("../src/queue.ts", () => ({ systemQueue: { add } }));

type Recipient = { id: string; phoneE164: string; variables: string[] };

const broadcastForRun = vi.fn<() => Promise<unknown>>();
const broadcastRunState = vi.fn<() => Promise<string>>();
const pendingRecipients = vi.fn<() => Promise<Recipient[]>>();
const materialiseRecipient =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      input: { recipientId: string },
    ) => Promise<{ recipientId: string; messageId: string; sendAttempt: number } | null>
  >();
const skipRecipient = vi.fn<() => Promise<void>>();
const completeBroadcastIfDone = vi.fn<() => Promise<boolean>>();
const pauseBroadcastAtTierLimit = vi.fn<() => Promise<boolean>>();
const uniqueRecipientsSince = vi.fn<() => Promise<number>>();
const findFirstNumber = vi.fn<() => Promise<{ messagingTier: string | null } | null>>();

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (
    companyId: string,
    callback: (db: unknown, id: string) => unknown,
  ) => callback({ whatsAppNumber: { findFirst: findFirstNumber } }, companyId),
  RECIPIENT_BATCH: 500,
  broadcastForRun: () => broadcastForRun(),
  broadcastRunState: () => broadcastRunState(),
  pendingRecipients: () => pendingRecipients(),
  materialiseRecipient: (
    db: unknown,
    companyId: string,
    input: { recipientId: string },
  ) => materialiseRecipient(db, companyId, input),
  skipRecipient: () => skipRecipient(),
  completeBroadcastIfDone: () => completeBroadcastIfDone(),
  pauseBroadcastAtTierLimit: () => pauseBroadcastAtTierLimit(),
  uniqueRecipientsSince: () => uniqueRecipientsSince(),
}));

const { handleBroadcastStart } = await import("../src/jobs/broadcast-start.ts");

function broadcast(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    status: "RUNNING",
    gapMs: 800,
    whatsappNumberId: "num-1",
    createdByUserId: "u1",
    recipientCount: 3,
    template: {
      id: "t1",
      name: "offer",
      language: "en_US",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
    },
    ...over,
  };
}

function recipients(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    phoneE164: `+91987654321${i}`,
    variables: ["Anita"],
  }));
}

/** One batch, then empty - the shape the loop terminates on. */
function oneBatch(rows: ReturnType<typeof recipients>) {
  pendingRecipients.mockResolvedValueOnce(rows).mockResolvedValue([]);
}

beforeEach(() => {
  add.mockClear();
  broadcastForRun.mockReset().mockResolvedValue(broadcast());
  broadcastRunState.mockReset().mockResolvedValue("runnable");
  pendingRecipients.mockReset().mockResolvedValue([]);
  skipRecipient.mockReset();
  completeBroadcastIfDone.mockReset().mockResolvedValue(false);
  pauseBroadcastAtTierLimit.mockReset().mockResolvedValue(true);
  uniqueRecipientsSince.mockReset().mockResolvedValue(0);
  /* Unlimited by default, so the pacing tests are about pacing. The tier tests
     below set a real one. */
  findFirstNumber.mockReset().mockResolvedValue({ messagingTier: "TIER_UNLIMITED" });
  materialiseRecipient
    .mockReset()
    .mockImplementation(async (_db, _c, input) => ({
      recipientId: input.recipientId,
      messageId: `m-${input.recipientId}`,
      sendAttempt: 0,
    }));
});

describe("the pacing", () => {
  it("spaces every send by the gap and sends the first immediately", async () => {
    /*
     * The assertion the whole phase rests on. A version that passed no delay
     * at all would send correctly, quickly, and get the number rate limited -
     * with nothing in any log to say why.
     */
    oneBatch(recipients(3));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    const delays = add.mock.calls.map((call) => call[2].delay);

    expect(delays).toEqual([0, 800, 1600]);
  });

  it("continues the schedule on a resume rather than restarting it", async () => {
    /*
     * scheduledSoFar is the whole reason the payload carries a count. A resume
     * that restarted at zero would send the entire remainder in one burst -
     * exactly when somebody had paused because something looked wrong.
     */
    oneBatch(recipients(2));

    await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 40,
    });

    const delays = add.mock.calls.map((call) => call[2].delay);

    expect(delays).toEqual([32_000, 32_800]);
  });

  it("uses the broadcast's frozen gap, not a constant", async () => {
    broadcastForRun.mockResolvedValue(broadcast({ gapMs: 250 }));
    oneBatch(recipients(2));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    const delays = add.mock.calls.map((call) => call[2].delay);

    expect(delays).toEqual([0, 250]);
  });
});

describe("what stops it", () => {
  it("schedules nothing when the broadcast is not running", async () => {
    broadcastForRun.mockResolvedValue(broadcast({ status: "PAUSED" }));

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("not_runnable");
    expect(add).not.toHaveBeenCalled();
  });

  it("stops scheduling mid-run when somebody pauses", async () => {
    /*
     * A pause pressed while ten thousand recipients are being scheduled has to
     * stop the SCHEDULING too, not only the sending. Otherwise Pause leaves a
     * queue that keeps draining for the next two hours, which is the opposite
     * of what the button says.
     */
    broadcastRunState.mockResolvedValue("paused");
    oneBatch(recipients(3));

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("not_runnable");
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses to schedule an unapproved template", async () => {
    /*
     * Meta re-checks on every send, so this is not the boundary - it is the
     * difference between one refusal and ten thousand. Scheduling a rejected
     * template burns the number's rating for no possible benefit and fills the
     * report with identical failures.
     */
    broadcastForRun.mockResolvedValue(
      broadcast({ template: { ...broadcast().template, status: "REJECTED" } }),
    );

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("template_not_approved");
    expect(add).not.toHaveBeenCalled();
  });

  it("does nothing for a broadcast that is not there", async () => {
    broadcastForRun.mockResolvedValue(null);

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "nope",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("not_found");
    expect(add).not.toHaveBeenCalled();
  });
});

describe("a recipient who must not be messaged", () => {
  it("skips one who opted out since the import, and does not enqueue", async () => {
    /*
     * The last filter at the last moment. Hours can pass between confirming a
     * broadcast and the queue reaching somebody, and an earlier recipient of
     * this very run can mark the same contact undeliverable.
     */
    materialiseRecipient.mockResolvedValue(null);
    oneBatch(recipients(2));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    expect(add, "enqueued a send for an opted-out contact").not.toHaveBeenCalled();
    expect(skipRecipient).toHaveBeenCalledTimes(2);
  });

  it("does not consume a slot in the schedule", async () => {
    /*
     * A skipped recipient must not leave an 800ms hole in the run. The counter
     * advances on what was actually enqueued, so a list that is half opt-outs
     * still sends at the configured pace rather than at half of it.
     */
    materialiseRecipient
      .mockResolvedValueOnce(null)
      .mockImplementation(async (_db, _c, input) => ({
        recipientId: input.recipientId,
        messageId: `m-${input.recipientId}`,
        sendAttempt: 0,
      }));
    oneBatch(recipients(3));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    const delays = add.mock.calls.map((call) => call[2].delay);

    expect(delays).toEqual([0, 800]);
  });
});

describe("the job ids", () => {
  it("names the message and its attempt, so a retry is not deduped away", async () => {
    /* BullMQ refuses a job whose id it already holds, silently. R2. */
    oneBatch(recipients(1));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    expect(add.mock.calls[0]?.[2].jobId).toBe(
      "send:m-r0:0",
    );
  });
});

describe("the messaging tier", () => {
  /**
   * The ceiling the pace cannot dodge.
   *
   * A broadcast paced perfectly and larger than the tier does not fail at the
   * end - it fails partway through, having already messaged part of the list,
   * with every refusal costing the number's quality rating. Scheduling up to
   * the limit and stopping is the same outcome without the damage.
   */
  it("schedules only what is left in the 24-hour window", async () => {
    findFirstNumber.mockResolvedValue({ messagingTier: "TIER_250" });
    uniqueRecipientsSince.mockResolvedValue(248);
    oneBatch(recipients(5));

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("tier_exhausted");
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("pauses rather than leaving a run that has quietly stopped", async () => {
    /*
     * A RUNNING broadcast that is not sending is indistinguishable from a
     * broken one, and the operator needs to know the reason is a limit rather
     * than a fault. The remaining recipients stay PENDING for a resume.
     */
    findFirstNumber.mockResolvedValue({ messagingTier: "TIER_250" });
    uniqueRecipientsSince.mockResolvedValue(250);
    oneBatch(recipients(3));

    await handleBroadcastStart({ companyId: "c1", broadcastId: "b1", scheduledSoFar: 0 });

    expect(pauseBroadcastAtTierLimit).toHaveBeenCalledTimes(1);
    expect(add, "sent past an exhausted tier").not.toHaveBeenCalled();
  });

  it("does not cap a number whose tier it cannot read", async () => {
    /*
     * Failing closed would stop a tenant broadcasting because a metadata
     * refresh has not run - a self-inflicted outage for a limit Meta enforces
     * itself. The send job's back-off is what catches it instead.
     */
    findFirstNumber.mockResolvedValue({ messagingTier: null });
    uniqueRecipientsSince.mockResolvedValue(99_999);
    oneBatch(recipients(3));

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 0,
    });

    expect(outcome.result).toBe("scheduled");
    expect(add).toHaveBeenCalledTimes(3);
  });

  it("counts only this pass against the allowance", async () => {
    /*
     * scheduledSoFar carries the pacing across a resume, and it must NOT be
     * counted against the tier: recipients scheduled yesterday are already
     * inside the `used` figure, so counting them twice would halve the
     * allowance on every resume until nothing could be sent at all.
     */
    findFirstNumber.mockResolvedValue({ messagingTier: "TIER_250" });
    uniqueRecipientsSince.mockResolvedValue(0);
    oneBatch(recipients(3));

    const outcome = await handleBroadcastStart({
      companyId: "c1",
      broadcastId: "b1",
      scheduledSoFar: 240,
    });

    expect(outcome.result).toBe("scheduled");
    expect(add).toHaveBeenCalledTimes(3);
  });
});
