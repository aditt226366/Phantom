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
const advanceConversation = vi.fn();

vi.mock("@whatsapp-os/db", () => ({
  /* The real one opens a transaction and passes a scoped client; the shape
     that matters to this test is that the callback receives (db, companyId). */
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn({ message: { create } }, companyId),
  canSend: async () => sendability,
  advanceConversation,
}));

const { sendMessageAction } = await import("@/app/(app)/inbox/actions");

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
