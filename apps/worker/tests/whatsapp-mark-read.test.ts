import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the mark-read job does with what it is given.
 *
 * The two rules that matter - only the newest inbound message is named, and the
 * badge is cleared conditionally - are proved against a real database in
 * packages/db/tests/read-receipts.test.ts, because both are about rows a
 * statement declines to touch. What is left here is this job's own shape: it
 * calls Meta once, it calls nothing at all when there is nothing to mark, and
 * it never holds a company scope while Meta is answering.
 */

interface Target {
  messageId: string;
  wamid: string;
  unreadCount: number;
}

/* Typed to the shapes the job calls, so the argument assertions below are
   checked rather than reaching into an inferred empty tuple. */
const readReceiptTarget =
  vi.fn<(db: unknown, companyId: string, conversationId: string) => Promise<Target | null>>();
const markConversationRead =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      conversationId: string,
      seen: number,
    ) => Promise<number>
  >();
const findFirstConversation = vi.fn();
const markWhatsAppRead =
  vi.fn<
    (
      secrets: Record<string, string>,
      wamid: string,
    ) => Promise<{
      ok: boolean;
      statusCode?: number;
      data?: unknown;
      kind?: string;
      error?: string;
    }>
  >();

let openScopes = 0;
const scopesOpenDuringGraphCall: number[] = [];

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, callback: (db: unknown, id: string) => unknown) => {
    openScopes++;
    try {
      return await callback(
        { conversation: { findFirst: findFirstConversation } },
        companyId,
      );
    } finally {
      openScopes--;
    }
  },
  readReceiptTarget,
  markConversationRead,
}));

vi.mock("@whatsapp-os/core/whatsapp", () => ({
  markWhatsAppRead: (secrets: Record<string, string>, wamid: string) => {
    scopesOpenDuringGraphCall.push(openScopes);
    return markWhatsAppRead(secrets, wamid);
  },
}));

vi.mock("@whatsapp-os/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/core")>()),
  decrypt: (ciphertext: string) => `plain:${ciphertext}`,
  secretAad: () => "aad",
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

const { handleWhatsAppMarkRead } = await import("../src/jobs/whatsapp-mark-read.ts");

const JOB = { companyId: "c1", conversationId: "cnv-1" };
const TARGET = {
  messageId: "msg-9",
  wamid: "wamid.9",
  unreadCount: 3,
};

const CONVERSATION = {
  whatsappNumber: {
    integrationId: "int-1",
    integration: { secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }] },
  },
};

beforeEach(() => {
  for (const mock of [
    readReceiptTarget,
    markConversationRead,
    findFirstConversation,
    markWhatsAppRead,
  ]) {
    mock.mockReset();
  }

  scopesOpenDuringGraphCall.length = 0;
  openScopes = 0;

  markConversationRead.mockResolvedValue(0);
  findFirstConversation.mockResolvedValue(CONVERSATION);
  markWhatsAppRead.mockResolvedValue({ ok: true, statusCode: 200, data: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a thread with something unread", () => {
  it("marks the newest message read and clears the badge", async () => {
    readReceiptTarget.mockResolvedValue(TARGET);

    const result = await handleWhatsAppMarkRead(JOB);

    expect(result).toEqual({ result: "marked" });
    expect(markWhatsAppRead).toHaveBeenCalledTimes(1);
    expect(markWhatsAppRead.mock.calls[0]![1]).toBe("wamid.9");

    /* Decremented by what the reader saw, not assigned zero. */
    expect(markConversationRead.mock.calls[0]![3]).toBe(3);
  });

  it("never holds a company scope while Meta is answering", async () => {
    readReceiptTarget.mockResolvedValue(TARGET);

    await handleWhatsAppMarkRead(JOB);

    expect(scopesOpenDuringGraphCall).toEqual([0]);
  });

  it("reports the badge being kept as a success, not a failure", async () => {
    readReceiptTarget.mockResolvedValue(TARGET);
    markConversationRead.mockResolvedValue(2);

    const result = await handleWhatsAppMarkRead(JOB);

    /*
     * Two messages arrived while the receipt was in flight, so the decrement
     * left exactly those behind. That is the reset working, and throwing here
     * would retry a call Meta has already accepted.
     */
    expect(result).toEqual({ result: "badge_kept" });
  });
});

describe("a thread with nothing to mark", () => {
  it("tells Meta nothing when there is nothing unread", async () => {
    readReceiptTarget.mockResolvedValue(null);

    const result = await handleWhatsAppMarkRead(JOB);

    expect(result).toEqual({ result: "nothing_to_mark" });
    expect(markWhatsAppRead).not.toHaveBeenCalled();
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it("does nothing for a conversation that is gone", async () => {
    readReceiptTarget.mockResolvedValue(TARGET);
    findFirstConversation.mockResolvedValue(null);

    const result = await handleWhatsAppMarkRead(JOB);

    expect(result).toEqual({ result: "nothing_to_mark" });
    expect(markWhatsAppRead).not.toHaveBeenCalled();
  });
});

describe("a call Meta refuses", () => {
  it("throws, because marking read twice is not a second anything", async () => {
    readReceiptTarget.mockResolvedValue(TARGET);
    markWhatsAppRead.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Timed out after 10000ms",
    });

    /*
     * This job keeps the default five attempts while the send job takes
     * exactly one, and the difference is idempotency: a repeated read receipt
     * costs nothing, a repeated send reaches a real customer twice.
     */
    await expect(handleWhatsAppMarkRead(JOB)).rejects.toThrow(/Could not mark/);
    expect(markConversationRead).not.toHaveBeenCalled();
  });
});
