import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate as behaviour, not as a call somebody wrote.
 *
 * feature-gate-coverage.test.ts reads the source and proves every entry point
 * CALLS the gate. That is worth having and it has a ceiling, which break-once
 * found: replacing the import with a local no-op stub leaves every call site
 * intact and the source-level check passes. A source test can prove the line
 * exists; only running it proves the line does anything.
 *
 * So this is the other half. A real server action, a blocked company, and the
 * assertion that the mutation does not happen.
 */

const SESSION = {
  sessionId: "session-1",
  companyId: "company-1",
  userId: "user-1",
  csrfSecret: "csrf",
};

vi.mock("@/lib/auth/session", () => ({ requireSession: async () => SESSION }));
vi.mock("@/lib/auth/csrf", () => ({ assertCsrf: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const add = vi.fn();
vi.mock("@/lib/queue", () => ({ systemQueue: { add } }));

const create = vi.fn();
const update = vi.fn();
const findFirst = vi.fn();

/**
 * canSend would allow this send. The gate is the only thing refusing.
 *
 * lib/auth/feature-gate.ts is deliberately NOT mocked - it is what is under
 * test, so this stubs what it reads rather than what it decides. A version
 * that mocked the gate itself would assert that a mock returns what it was
 * told to.
 */
vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn(
      {
        message: { create, update, findFirst },
        /* Active. So the refusal below is about documents, not suspension. */
        company: { findFirst: async () => ({ deactivatedAt: null }) },
      },
      companyId,
    ),
  /* Nothing filed - where every real tenant starts. */
  currentKycStatuses: async () => ({ GST: null, PAN: null, AADHAAR: null }),
  canSend: async () => ({
    conversationId: "conv-1",
    window: { state: "open" },
    decision: { allowed: true },
    phoneNumberId: "pn-1",
    waId: "wa-1",
  }),
  advanceConversation: vi.fn(),
}));

const { sendMessageAction } = await import("@/app/(app)/inbox/actions");

function composer(): FormData {
  const form = new FormData();
  form.set("conversationId", "conv-1");
  form.set("body", "hello");
  return form;
}

beforeEach(() => {
  add.mockClear();
  create.mockClear();
  update.mockClear();
});

describe("a blocked workspace", () => {
  it("cannot send, even when every send precondition is met", async () => {
    /*
     * The conversation is open, the number is fine, the contact has not opted
     * out - canSend above says yes to all of it. What refuses is A4.
     *
     * assertFeatureAccess throws rather than returning a verdict precisely so
     * that this cannot be got wrong: there is no way to call it and carry on.
     * An action that received a decision would have to remember to act on it,
     * and forgetting means the mutation lands while the gate reports a refusal
     * nobody read.
     */
    await expect(sendMessageAction({}, composer())).rejects.toThrow(
      /not verified/i,
    );

    expect(create, "wrote a message for a blocked workspace").not.toHaveBeenCalled();
    expect(add, "enqueued a send for a blocked workspace").not.toHaveBeenCalled();
  });
});
