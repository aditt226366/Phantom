import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendJobId } from "@whatsapp-os/core/queues";

/**
 * The composer writes a row and enqueues a job. Nothing else.
 *
 * Two failures here would be completely silent, which is why this exists at
 * all rather than being left to the worker's own tests:
 *
 *   1. Enqueueing a send the policy refused. canSend runs twice by design -
 *      here for feedback and in the worker as the boundary - and it is very
 *      easy to write a version of this action that reports the refusal to the
 *      operator and enqueues anyway. The worker would then decline it, so
 *      nothing reaches the customer and nothing errors: the only evidence is a
 *      FAILED bubble appearing seconds after the composer already said no.
 *
 *   2. Getting the job id wrong. BullMQ refuses a job whose id it already
 *      holds, silently, because for every other job in this system that
 *      refusal IS the deduplication (R2). An id that does not carry the
 *      attempt makes every retry a no-op that looks like a dead button.
 *
 * The database is mocked rather than seeded: what is under test is the order
 * of operations in the action, and canSend has its own tests against real
 * policies in packages/db.
 */

const SESSION = {
  sessionId: "session-1",
  companyId: "company-1",
  userId: "user-1",
  csrfSecret: "csrf",
};

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => SESSION,
}));

vi.mock("@/lib/auth/csrf", () => ({ assertCsrf: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const add = vi.fn();
vi.mock("@/lib/queue", () => ({ systemQueue: { add } }));

/** What canSend will answer. Set per test. */
let sendability: unknown = null;
const create = vi.fn();
const update = vi.fn();
const findFirst = vi.fn();
const advanceConversation = vi.fn();
/* No flow standing in this conversation, which is the ordinary case for a
   thread somebody is typing into by hand. The handoff path has its own tests
   against a real database in packages/db. */
const findFirstFlowRun = vi.fn(async () => null);
const handOff = vi.fn();
/*
 * Nothing was driving this thread, which is the ordinary case for a
 * conversation somebody is typing into by hand.
 *
 * Typed to the real signature rather than `async () => ...`: a zero-argument
 * implementation types mock.calls as the empty tuple, which runs and fails
 * `tsc`. The conventions record that one.
 *
 * The interesting driver cases - an operator displacing a flow, an automation
 * refused a thread another automation holds - are asserted against a real
 * database in packages/db/tests/conversation-driver.test.ts, because they are
 * about a single UPDATE's WHERE clause and a mock would only restate them.
 */
const claimDriver = vi.fn(
  async (_db: unknown, _companyId: string, _conversationId: string, _input: unknown) => ({
    kind: "claimed" as const,
    displaced: "NOBODY" as const,
    displacedRef: null,
  }),
);

vi.mock("@whatsapp-os/db", () => ({
  /* The real one opens a transaction and passes a scoped client; the shape
     that matters to this test is that the callback receives (db, companyId). */
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn(
      {
        message: { create, update, findFirst },
        flowRun: { findFirst: findFirstFlowRun },
        /* Active, so the gate below refuses on documents or not at all. */
        company: { findFirst: async () => ({ deactivatedAt: null }) },
      },
      companyId,
    ),
  /*
   * A verified workspace, because these are tests about the send path and A4
   * put a gate in front of it. Without this every assertion here would pass or
   * fail for the wrong reason - refused by KYC rather than by the window, the
   * policy or the status ladder each one names.
   *
   * The gate's own refusal of this same action is asserted deliberately, in
   * feature-gate.test.ts, against a company that has filed nothing.
   */
  currentKycStatuses: async () => ({
    GST: "APPROVED",
    PAN: "APPROVED",
    AADHAAR: "APPROVED",
  }),
  canSend: async () => sendability,
  advanceConversation,
  handOff,
  claimDriver,
}));

const { retryMessageAction, sendMessageAction } = await import(
  "@/app/(app)/inbox/actions"
);

function submission(body: string): FormData {
  const form = new FormData();
  form.set("conversationId", "conversation-1");
  form.set("body", body);
  return form;
}

beforeEach(() => {
  add.mockReset();
  create.mockReset();
  advanceConversation.mockReset();
  update.mockReset();
  findFirst.mockReset();
  create.mockResolvedValue({ id: "message-1", sendAttempt: 0 });
});

describe("sendMessageAction", () => {
  it("writes the row and enqueues it when the window is open", async () => {
    sendability = { decision: { allowed: true } };

    const state = await sendMessageAction({}, submission("On its way."));

    expect(state.error).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);

    /* PENDING and OUTBOUND, with no wamid: Meta has not seen this yet, and the
       worker refuses to send a row that already has one. */
    const row = create.mock.calls[0]?.[0]?.data;
    expect(row).toMatchObject({
      direction: "OUTBOUND",
      status: "PENDING",
      type: "text",
      body: "On its way.",
      sentByUserId: "user-1",
      sendAttempt: 0,
    });

    /* An outbound message never opens or extends a window - only the customer
       writing does - so this must be null however tempting it looks. */
    expect(advanceConversation.mock.calls[0]?.[3]).toMatchObject({
      inbound: false,
      unread: 0,
      windowExpiresAt: null,
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[2]?.jobId).toBe(sendJobId("message-1", 0));
    /* attempts: 1 travels with the contract. An automatic retry after a
       timeout sends a real customer the same message twice. */
    expect(add.mock.calls[0]?.[2]?.attempts).toBe(1);
  });

  it("enqueues nothing when the policy refuses", async () => {
    sendability = {
      decision: { allowed: false, reason: "window_closed" },
    };

    const state = await sendMessageAction({}, submission("Too late."));

    expect(state.error).toMatch(/24 hours/);
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    /* The draft comes back so the operator does not retype it into a template. */
    expect(state.draft).toBe("Too late.");
  });

  it("enqueues nothing for a conversation that is not this company's", async () => {
    /* Rule 6: canSend answers null rather than refusing with a reason, because
       a "you may not send to this" verdict would confirm the row exists. */
    sendability = null;

    const state = await sendMessageAction({}, submission("Hello?"));

    expect(state.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses an empty body before touching anything", async () => {
    sendability = { decision: { allowed: true } };

    const state = await sendMessageAction({}, submission("   "));

    expect(state.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

describe("retryMessageAction", () => {
  function retrySubmission(): FormData {
    const form = new FormData();
    form.set("messageId", "message-1");
    return form;
  }

  it("increments the attempt and puts it in the job id", async () => {
    /* R2. BullMQ refuses a job whose id it already holds, silently, because
       for every other job here that refusal IS the deduplication - so a retry
       enqueued under the first attempt's id is dropped and the button looks
       dead. The attempt number is the thing that makes the id new. */
    findFirst.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      status: "FAILED",
      wamid: null,
      sendAttempt: 0,
    });
    update.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      sendAttempt: 1,
    });

    const state = await retryMessageAction({}, retrySubmission());

    expect(state.error).toBeUndefined();
    expect(update.mock.calls[0]?.[0]?.data?.sendAttempt).toEqual({ increment: 1 });
    expect(add.mock.calls[0]?.[1]?.sendAttempt).toBe(1);
    expect(add.mock.calls[0]?.[2]?.jobId).toBe(sendJobId("message-1", 1));
  });

  it("clears the previous attempt's reason", async () => {
    /* A bubble that has gone back to Sending must not still carry last time's
       failure underneath it. */
    findFirst.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      status: "FAILED",
      wamid: null,
      sendAttempt: 2,
    });
    update.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      sendAttempt: 3,
    });

    await retryMessageAction({}, retrySubmission());

    expect(update.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "PENDING",
      errorSource: null,
      errorCode: null,
      errorTitle: null,
    });
  });

  /*
   * The dangerous one, and the reason the server asks again rather than
   * trusting the button. Meta names a message when it accepts it; a second
   * POST for a named message reaches a real customer twice and cannot be
   * un-sent. A stale page or a hand-made form is all it would take.
   */
  it("refuses a message Meta has already named", async () => {
    findFirst.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      status: "FAILED",
      wamid: "wamid.HBgMOTE5ODEyMzQ1Njkx",
      sendAttempt: 0,
    });

    const state = await retryMessageAction({}, retrySubmission());

    expect(state.error).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(["SENT", "DELIVERED", "READ", "PENDING"])(
    "refuses to re-send a %s message",
    async (status) => {
      findFirst.mockResolvedValue({
        id: "message-1",
        conversationId: "conversation-1",
        status,
        wamid: null,
        sendAttempt: 0,
      });

      const state = await retryMessageAction({}, retrySubmission());

      expect(state.error).toBeTruthy();
      expect(update).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    },
  );
});
