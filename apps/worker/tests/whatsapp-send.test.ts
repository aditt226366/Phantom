import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The send job's shape, which is where its safety lives.
 *
 * What each outcome writes is proved against a real database in
 * packages/db/tests/send-outcomes.test.ts. What is asserted here is the
 * sequence: canSend runs immediately before the call and not in the composer's
 * stale answer, nothing is sent when it refuses, a message that already has a
 * wamid is never sent twice, and no company scope is open while Meta is
 * answering.
 */

interface Decision {
  allowed: boolean;
  reason?: string;
}

const findFirstMessage = vi.fn();
const findFirstContact = vi.fn();
const updateContact = vi.fn(async () => ({}));
const canSend =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      conversationId: string,
      intent: unknown,
      now: Date,
    ) => Promise<{ waId: string; decision: Decision } | null>
  >();
const sendWhatsAppText = vi.fn();
const sendWhatsAppTemplate = vi.fn();
/* Typed to the shapes the job calls, so the argument assertions below are
   checked rather than reaching into an inferred empty tuple. */
const recordSendAccepted =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      messageId: string,
      acceptance: { wamid: string; held: boolean; waId: string | null },
    ) => Promise<void>
  >();
const recordSendRefused =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      messageId: string,
      failure: {
        code: number | null;
        title: string;
        occurredAt: Date;
        kind: string;
        integrationId: string;
      },
    ) => Promise<void>
  >();
const recordSendUnconfirmed =
  vi.fn<(db: unknown, companyId: string, messageId: string) => Promise<void>>();
const recordSendDeclined =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      messageId: string,
      reason: string,
      occurredAt: Date,
    ) => Promise<void>
  >();
const recordUsage =
  vi.fn<
    (db: unknown, companyId: string, input: { kind: string; dedupeKey: string }) => Promise<unknown>
  >();
/** What the broadcast this message belongs to says. "runnable" unless set. */
const broadcastRunState =
  vi.fn<
    (db: unknown, companyId: string, broadcastId: string) => Promise<string>
  >();
const markContactUndeliverable =
  vi.fn<
    (db: unknown, companyId: string, contactId: string, at: Date) => Promise<void>
  >();
const pauseBroadcastForRateLimit =
  vi.fn<
    (db: unknown, companyId: string, broadcastId: string) => Promise<boolean>
  >();

/** Rises while a company scope is open, so a call inside one is visible. */
let openScopes = 0;
const scopesOpenDuringSend: number[] = [];
/** The order the interesting steps ran in. */
const sequence: string[] = [];

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, callback: (db: unknown, id: string) => unknown) => {
    openScopes++;
    try {
      return await callback(
        {
          message: { findFirst: findFirstMessage },
          contact: { findFirst: findFirstContact, update: updateContact },
        },
        companyId,
      );
    } finally {
      openScopes--;
    }
  },
  canSend: (...args: Parameters<typeof canSend>) => {
    sequence.push("canSend");
    return canSend(...args);
  },
  recordSendAccepted,
  recordSendRefused,
  recordSendUnconfirmed,
  recordSendDeclined,
  recordUsage,
  broadcastRunState: (...args: Parameters<typeof broadcastRunState>) => {
    sequence.push("broadcastRunState");
    return broadcastRunState(...args);
  },
  markContactUndeliverable,
  pauseBroadcastForRateLimit,
}));

vi.mock("@whatsapp-os/core/whatsapp", () => ({
  sendWhatsAppTemplate: (
    secrets: Record<string, string>,
    input: { to: string; name: string; language: string; parameters: string[] },
  ) => {
    /* Recorded the same way the text send is, so "no scope open while Meta is
       answering" holds for both kinds rather than only the one it was written
       against. */
    sequence.push("graph");
    scopesOpenDuringSend.push(openScopes);
    return sendWhatsAppTemplate(secrets, input);
  },
  sendWhatsAppText: (secrets: Record<string, string>, input: { to: string; body: string }) => {
    sequence.push("graph");
    scopesOpenDuringSend.push(openScopes);
    return sendWhatsAppText(secrets, input);
  },
}));

vi.mock("@whatsapp-os/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/core")>()),
  decrypt: (ciphertext: string) => `plain:${ciphertext}`,
  secretAad: () => "aad",
}));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

const { handleWhatsAppMessageSend } = await import("../src/jobs/whatsapp-send.ts");

const JOB = { companyId: "c1", messageId: "m1", sendAttempt: 0 };

function messageRow(
  over: { wamid?: string | null; waId?: string; broadcastId?: string | null } = {},
) {
  return {
    id: "m1",
    conversationId: "cnv-1",
    body: "hello",
    wamid: over.wamid ?? null,
    /* Null means an ordinary send. A broadcast recipient carries the run, and
       the job has to consult its status before doing anything at all. */
    broadcastId: over.broadcastId ?? null,
    conversation: {
      contact: { id: "ct-1", waId: over.waId ?? "wa-customer" },
      whatsappNumber: {
        integrationId: "int-1",
        integration: {
          secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }],
        },
      },
    },
  };
}

beforeEach(() => {
  for (const mock of [
    findFirstMessage,
    findFirstContact,
    updateContact,
    canSend,
    sendWhatsAppText,
    sendWhatsAppTemplate,
    recordSendAccepted,
    recordSendRefused,
    recordSendUnconfirmed,
    recordSendDeclined,
    recordUsage,
    broadcastRunState,
    markContactUndeliverable,
    pauseBroadcastForRateLimit,
  ]) {
    mock.mockReset();
  }

  scopesOpenDuringSend.length = 0;
  sequence.length = 0;
  openScopes = 0;

  findFirstMessage.mockResolvedValue(messageRow());
  findFirstContact.mockResolvedValue(null);
  updateContact.mockResolvedValue({});
  canSend.mockResolvedValue({ waId: "wa-customer", decision: { allowed: true } });
  recordUsage.mockResolvedValue({});
  broadcastRunState.mockResolvedValue("runnable");
  markContactUndeliverable.mockResolvedValue(undefined);
  pauseBroadcastForRateLimit.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Meta accepts the message", () => {
  it("stores what Meta called it and bills the message once", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      waId: "wa-customer",
      messageStatus: "accepted",
      held: false,
    });

    const result = await handleWhatsAppMessageSend(JOB);

    expect(result).toEqual({ result: "sent" });
    expect(recordSendAccepted.mock.calls[0]![3]).toMatchObject({
      wamid: "wamid.1",
      held: false,
    });

    /*
     * Deduped on the message id, never the wamid - C3. The wamid does not exist
     * until Meta answers, so a retried send produces a second one for the same
     * message and this table becomes an invoice.
     */
    const usage = recordUsage.mock.calls[0]![2];
    expect(usage.kind).toBe("whatsapp.message.sent");
    expect(usage.dedupeKey).toContain("m1");
    expect(usage.dedupeKey).not.toContain("wamid");
  });

  it("reports a hold as held", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      waId: null,
      messageStatus: "held_for_quality_assessment",
      held: true,
    });

    expect(await handleWhatsAppMessageSend(JOB)).toEqual({ result: "held" });
  });

  it("moves the contact onto the wa_id Meta actually uses", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ waId: "5511987654321" }));
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      /* Brazil: the number that messages and the wa_id it arrives as differ by
         a digit. Left alone, the reply creates a second contact with its own
         window for the same person. */
      waId: "551187654321",
      messageStatus: "accepted",
      held: false,
    });

    await handleWhatsAppMessageSend(JOB);

    expect(updateContact).toHaveBeenCalledWith({
      where: { id: "ct-1" },
      data: { waId: "551187654321" },
    });
  });

  it("does not merge two contacts when the canonical wa_id is taken", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ waId: "5511987654321" }));
    findFirstContact.mockResolvedValue({ id: "ct-other" });
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      waId: "551187654321",
      messageStatus: "accepted",
      held: false,
    });

    await handleWhatsAppMessageSend(JOB);

    /* Two rows for one person is a merge - moving conversations and messages -
       and that must not happen as a side effect of a message going out. */
    expect(updateContact).not.toHaveBeenCalled();
  });
});

describe("the boundary", () => {
  it("re-checks canSend immediately before the call, not before the decrypt", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      waId: null,
      messageStatus: "accepted",
      held: false,
    });

    await handleWhatsAppMessageSend(JOB);

    /*
     * The composer already ran canSend and showed an answer. By the time a
     * queue has been through it that answer is minutes old, and the 24-hour
     * window can close in between - which is exactly the case where the
     * composer said yes and Meta would say no.
     */
    expect(sequence).toEqual(["canSend", "graph"]);
  });

  it("sends nothing when the window closed while the job was queued", async () => {
    canSend.mockResolvedValue({
      waId: "wa-customer",
      decision: { allowed: false, reason: "window_closed" },
    });

    const result = await handleWhatsAppMessageSend(JOB);

    expect(result).toEqual({ result: "declined" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();

    /* Recorded on the row, so the refusal reaches the thread rather than only
       a log line. */
    expect(recordSendDeclined.mock.calls[0]![3]).toBe("window_closed");
  });

  /*
   * The asymmetry, at the layer that acts on it.
   *
   * A template is the one thing allowed once the window has closed, so the
   * intent the worker asks with has to match what it is about to send. Asking
   * `freeform` for a template row would be refused by the very window the
   * template exists to survive - and the failure is silent from the outside:
   * the send is declined, the customer gets nothing, and the only evidence is
   * a POLICY failure on a row somebody has to open the thread to see.
   */
  it("asks about a template as a template, not as free-form", async () => {
    findFirstMessage.mockResolvedValue({
      ...messageRow(),
      body: "Reminder: your appointment is on Thursday at 3pm.",
      templatePayload: {
        name: "appointment_reminder",
        language: "en_US",
        parameters: ["Thursday", "3pm"],
      },
    });

    canSend.mockImplementation(async (_db, _companyId, _conversationId, intent) => ({
      waId: "wa-customer",
      /* What the real policy does: free-form is refused once the window has
         gone, a template is not. Mirrored here so the assertion is about the
         intent the worker chose rather than about a stub that always says yes. */
      decision:
        (intent as { kind: string }).kind === "template"
          ? { allowed: true }
          : { allowed: false, reason: "window_closed" },
    }));

    sendWhatsAppTemplate.mockResolvedValue({
      ok: true,
      wamid: "wamid.template",
      waId: null,
      messageStatus: "accepted",
      held: false,
    });

    const result = await handleWhatsAppMessageSend(JOB);

    expect(result).toEqual({ result: "sent" });
    expect(canSend.mock.calls[0]![3]).toEqual({
      kind: "template",
      approved: true,
    });

    /* And it went out as a template, with Meta's positional parameters intact. */
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate.mock.calls[0]![1]).toMatchObject({
      name: "appointment_reminder",
      language: "en_US",
      parameters: ["Thursday", "3pm"],
    });
  });

  it("never holds a company scope while Meta is answering", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: true,
      wamid: "wamid.1",
      waId: null,
      messageStatus: "accepted",
      held: false,
    });

    await handleWhatsAppMessageSend(JOB);

    expect(scopesOpenDuringSend).toEqual([0]);
  });

  it("refuses to send a message that already has a wamid", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ wamid: "wamid.already" }));

    const result = await handleWhatsAppMessageSend(JOB);

    /*
     * The single most expensive mistake available here. A wamid means Meta has
     * it, and a second POST reaches a real customer twice with no way to
     * un-send.
     */
    expect(result).toEqual({ result: "already_sent" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});

describe("Meta refuses", () => {
  it("records its code and title, and bills nothing", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: false,
      delivery: "refused",
      kind: "config",
      statusCode: 400,
      error: "Re-engagement message outside the 24 hour window",
      details: { code: 131_047 },
    });

    const result = await handleWhatsAppMessageSend(JOB);

    expect(result).toEqual({ result: "refused" });
    expect(recordUsage).not.toHaveBeenCalled();

    /*
     * The kind and the integration are what let the recorder decide whether the
     * badge moves. Passing statusCode instead would get Meta wrong in both
     * directions - 190 arrives with a 400 as often as a 401, and the rate-limit
     * codes 4, 17 and 32 arrive as 400 too.
     */
    expect(recordSendRefused.mock.calls[0]![3]).toMatchObject({
      code: 131_047,
      kind: "config",
      integrationId: "int-1",
    });
  });
});

describe("Meta does not answer", () => {
  it("records the message as unconfirmed and bills nothing", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: false,
      delivery: "unknown",
      error: "Timed out after 10000ms",
    });

    const result = await handleWhatsAppMessageSend(JOB);

    /*
     * Not failed - we do not know it failed. Not sent - we do not know that
     * either. And not left pending, which anything claiming work by status
     * would pick up and send again.
     */
    expect(result).toEqual({ result: "unconfirmed" });
    expect(recordSendUnconfirmed).toHaveBeenCalledTimes(1);
    expect(recordSendRefused).not.toHaveBeenCalled();
    expect(recordSendAccepted).not.toHaveBeenCalled();

    /* If Meta did send it we under-bill by one, which is the right way round to
       be wrong about an invoice. */
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("does not throw, because a retry is the dangerous response", async () => {
    sendWhatsAppText.mockResolvedValue({
      ok: false,
      delivery: "unknown",
      error: "Timed out after 10000ms",
    });

    /*
     * Throwing would mark the job failed. attempts: 1 means BullMQ would not
     * retry it today, but the reason to return cleanly is that the outcome is
     * recorded and a person decides - not that the queue happens to be
     * configured to agree.
     */
    await expect(handleWhatsAppMessageSend(JOB)).resolves.toEqual({
      result: "unconfirmed",
    });
  });
});

describe("a message that is part of a broadcast", () => {
  /**
   * The pause check, and why it is where it is.
   *
   * Thousands of sends sit in Redis with their delays already computed.
   * Removing them on a pause would be a slow, racy sweep of a structure being
   * consumed at the same time; letting every job wake up and ask costs one
   * indexed read and is exact. That only works if the read actually happens,
   * and a job that skipped it would keep draining a paused campaign with no
   * error anywhere - the definition of a silent failure.
   */
  it("does not consult a broadcast for an ordinary send", async () => {
    findFirstMessage.mockResolvedValue(messageRow());
    sendWhatsAppText.mockResolvedValue({ ok: true, wamid: "w", held: false, waId: null });

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(broadcastRunState).not.toHaveBeenCalled();
  });

  it("sends nothing while the broadcast is paused", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    broadcastRunState.mockResolvedValue("paused");

    const outcome = await handleWhatsAppMessageSend({
      companyId: "c1",
      messageId: "m1",
      sendAttempt: 0,
    });

    expect(outcome.result).toBe("broadcast_paused");
    expect(sendWhatsAppText, "sent while paused").not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate, "sent while paused").not.toHaveBeenCalled();
  });

  it("leaves a paused message untouched, so a resume can pick it up", async () => {
    /*
     * Nothing is written at all. The row stays PENDING, which is what lets a
     * resume re-enqueue it - marking it failed would lose the recipients that
     * happened to be mid-flight when somebody pressed Pause.
     */
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    broadcastRunState.mockResolvedValue("paused");

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(recordSendDeclined).not.toHaveBeenCalled();
    expect(recordSendUnconfirmed).not.toHaveBeenCalled();
    expect(recordSendAccepted).not.toHaveBeenCalled();
  });

  it("declines with a reason when the broadcast was cancelled", async () => {
    /* Recorded rather than dropped: the message row exists and somebody will
       look at it, and a row with no status and no reason is the shape of a bug
       where "the campaign was cancelled" is the shape of an answer. */
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    broadcastRunState.mockResolvedValue("stopped");

    const outcome = await handleWhatsAppMessageSend({
      companyId: "c1",
      messageId: "m1",
      sendAttempt: 0,
    });

    expect(outcome.result).toBe("declined");
    expect(recordSendDeclined.mock.calls[0]?.[3]).toBe("broadcast_cancelled");
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("checks the run before decrypting or asking canSend", async () => {
    /*
     * Ordering, not correctness - both refuse. A paused broadcast should not
     * be doing key material work, and a cancelled one should not be reading
     * credentials at all.
     */
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    broadcastRunState.mockResolvedValue("paused");

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(sequence).toEqual(["broadcastRunState"]);
    expect(canSend).not.toHaveBeenCalled();
  });

  it("sends normally when the broadcast is running", async () => {
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    sendWhatsAppText.mockResolvedValue({ ok: true, wamid: "w", held: false, waId: null });

    const outcome = await handleWhatsAppMessageSend({
      companyId: "c1",
      messageId: "m1",
      sendAttempt: 0,
    });

    expect(outcome.result).toBe("sent");
    expect(broadcastRunState).toHaveBeenCalledTimes(1);
  });
});

describe("what a refusal means beyond one message", () => {
  /**
   * Two of Meta's codes say something about more than the message that
   * produced them, and acting on it is the difference between learning and
   * repeating the same mistake once per campaign.
   */
  function refuse(code: number) {
    sendWhatsAppText.mockResolvedValue({
      ok: false,
      delivery: "refused",
      kind: "config",
      error: "refused",
      details: { code },
    });
  }

  it("remembers a handset that cannot receive WhatsApp", async () => {
    /*
     * 131026, on the CONTACT rather than the recipient row, because it is a
     * fact about the number. resolveAudience drops them at import from then
     * on, so a future broadcast never spends a send to be told again.
     */
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    refuse(131026);

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(markContactUndeliverable).toHaveBeenCalledTimes(1);
    expect(markContactUndeliverable.mock.calls[0]?.[2]).toBe("ct-1");
    expect(pauseBroadcastForRateLimit).not.toHaveBeenCalled();
  });

  it("pauses the run on every documented rate limit", async () => {
    for (const code of [131049, 130472, 131056, 133016]) {
      pauseBroadcastForRateLimit.mockClear();
      findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
      refuse(code);

      await handleWhatsAppMessageSend({
        companyId: "c1",
        messageId: "m1",
        sendAttempt: 0,
      });

      expect(
        pauseBroadcastForRateLimit,
        `${code} did not pause the run`,
      ).toHaveBeenCalledTimes(1);
    }
  });

  it("does not pause for an ordinary failure", async () => {
    /*
     * The important negative. If an unrecognised code paused the run, one bad
     * recipient would stop a broadcast to ten thousand people - and the
     * symptom would be a campaign that mysteriously halts.
     */
    findFirstMessage.mockResolvedValue(messageRow({ broadcastId: "b1" }));
    refuse(131047);

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(pauseBroadcastForRateLimit).not.toHaveBeenCalled();
    expect(markContactUndeliverable).not.toHaveBeenCalled();
  });

  it("does not pause anything for a message sent by hand", async () => {
    /* An operator sending one message has already seen the failure, and
       pausing something they are not running would act on a state that does
       not exist. */
    findFirstMessage.mockResolvedValue(messageRow());
    refuse(133016);

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(pauseBroadcastForRateLimit).not.toHaveBeenCalled();
  });

  it("still marks a handset undeliverable outside a broadcast", async () => {
    /* The contact fact is not campaign-scoped: learning it from an inbox send
       has to protect every future broadcast too. */
    findFirstMessage.mockResolvedValue(messageRow());
    refuse(131026);

    await handleWhatsAppMessageSend({ companyId: "c1", messageId: "m1", sendAttempt: 0 });

    expect(markContactUndeliverable).toHaveBeenCalledTimes(1);
  });
});
