import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading one bound spreadsheet, which is where the leads come from.
 *
 * Four failures here are silent and each one costs something that cannot be
 * taken back:
 *
 *   1. A duplicate claim that goes through. A real customer receives the same
 *      WhatsApp message twice. Nothing errors.
 *   2. The cursor advanced past rows a failed read never looked at. Those
 *      leads are never contacted, and the binding looks perfectly healthy.
 *   3. A 429 answered by polling again. Sheets meters per PROJECT, so one
 *      tenant's binding takes every other tenant's bindings down with it.
 *   4. A lost share reported as a blip. The tenant's page says nothing is
 *      wrong while their whole lead list goes uncontacted.
 */

/**
 * Every mock is typed to the signature it stands in for.
 *
 * vi.fn with a zero-argument implementation infers its call tuple as [], so
 * indexing an options argument runs perfectly and fails to typecheck. The
 * conventions record it; it is worth the extra line here because the job id
 * assertion below reads exactly that argument.
 */
type JobOptions = { jobId: string; attempts: number };

const add =
  vi.fn<(name: string, data: unknown, options: JobOptions) => Promise<unknown>>();
vi.mock("../src/queue.ts", () => ({ systemQueue: { add } }));

vi.mock("../src/keyring.ts", () => ({ keyring: () => ({}) }));

const readSheetValues = vi.fn<() => Promise<unknown>>();
vi.mock("@whatsapp-os/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readSheetValues: () => readSheetValues(),
    /* The credential never reaches this test. Decryption is exercised by the
       vault suite, and stubbing it keeps this file about the poll. */
    decrypt: (value: string) => value,
  };
});

type Claim =
  | { kind: "sent"; rowId: string; messageId: string; sendAttempt: number }
  | { kind: "skipped"; rowId: string; reason: string }
  | { kind: "duplicate" };

const leadSourceForPoll = vi.fn<() => Promise<unknown>>();
const claimLeadRow =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      input: { rowHash: string; tab: string; spreadsheetId: string },
    ) => Promise<Claim>
  >();
const recordPoll =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      id: string,
      input: {
        counts: Record<string, unknown>;
        cursor: { count: number; anchor: string | null };
        at: Date;
      },
    ) => Promise<void>
  >();
const recordPollFailure =
  vi.fn<
    (
      db: unknown,
      companyId: string,
      id: string,
      input: {
        error: string;
        at: Date;
        demote: boolean;
        backoffUntil?: Date | null;
      },
    ) => Promise<void>
  >();
const findFirstIntegration = vi.fn<() => Promise<unknown>>();

class DuplicateError extends Error {}

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (
    companyId: string,
    callback: (db: unknown, id: string) => unknown,
  ) => callback({ integration: { findFirst: findFirstIntegration } }, companyId),
  leadSourceForPoll: () => leadSourceForPoll(),
  claimLeadRow: (
    db: unknown,
    companyId: string,
    input: { rowHash: string; tab: string; spreadsheetId: string },
  ) => claimLeadRow(db, companyId, input),
  recordPoll: (
    db: unknown,
    companyId: string,
    id: string,
    input: Parameters<typeof recordPoll>[3],
  ) => recordPoll(db, companyId, id, input),
  recordPollFailure: (
    db: unknown,
    companyId: string,
    id: string,
    input: Parameters<typeof recordPollFailure>[3],
  ) => recordPollFailure(db, companyId, id, input),
  isDuplicateLead: (error: unknown) => error instanceof DuplicateError,
}));

const { handleLeadSourcePoll } = await import("../src/jobs/lead-source-poll.ts");

const PAYLOAD = { companyId: "c1", leadSourceId: "ls1" };

const TEMPLATE = {
  id: "t1",
  name: "welcome",
  language: "en_US",
  status: "APPROVED",
  components: [{ type: "BODY", text: "Hello {{1}}" }],
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: "ls1",
    spreadsheetId: "sheet-1",
    tab: "Leads",
    status: "ACTIVE",
    action: "TEMPLATE",
    actionConfig: {
      kind: "TEMPLATE",
      templateId: "t1",
      mapping: { phone: "Mobile", variables: { "1": "Name" } },
    },
    whatsappNumberId: "n1",
    createdByUserId: null,
    cursorCount: 0,
    cursorAnchor: null,
    backoffUntil: null,
    template: TEMPLATE,
    ...overrides,
  };
}

const SHEET = [
  ["Name", "Mobile"],
  ["Asha", "9876543210"],
  ["Ravi", "9876543211"],
];

beforeEach(() => {
  vi.clearAllMocks();
  leadSourceForPoll.mockResolvedValue(binding());
  readSheetValues.mockResolvedValue({ ok: true, rows: SHEET });
  findFirstIntegration.mockResolvedValue({
    id: "i1",
    secrets: [
      { key: "GOOGLE_SERVICE_ACCOUNT_EMAIL", ciphertext: "leads@example.com" },
      { key: "GOOGLE_PRIVATE_KEY", ciphertext: "key" },
    ],
  });
  claimLeadRow.mockImplementation(async () => ({
    kind: "sent",
    rowId: "r1",
    messageId: "m1",
    sendAttempt: 0,
  }));
  recordPoll.mockResolvedValue(undefined);
  recordPollFailure.mockResolvedValue(undefined);
  add.mockResolvedValue(undefined);
});

describe("a healthy poll", () => {
  it("claims every new row and enqueues an ordinary send", async () => {
    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result).toEqual({ result: "polled", sent: 2 });
    expect(claimLeadRow).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("hands the send to the existing primitive, not a second path", async () => {
    /*
     * The Phase 5 rule, one producer later. Same job name, same job id
     * convention, same attempts: 1 - which is what makes canSend, the
     * three-way outcome and usage-deduped-on-messageId apply to a lead
     * without this file knowing any of them exist.
     */
    await handleLeadSourcePoll(PAYLOAD);

    const [name, data, options] = add.mock.calls[0]!;

    expect(name).toBe("whatsapp.message.send");
    expect(data).toEqual({ companyId: "c1", messageId: "m1", sendAttempt: 0 });
    expect(options.jobId).toBe("send:m1:0");
    expect(options.attempts).toBe(1);
  });

  it("claims against the tab it read, not just the spreadsheet", async () => {
    /*
     * The tab is part of the unique key. Without it here, two bindings on
     * different tabs of one workbook collide and the second is permanently
     * dead - every row it reads counts as a duplicate and nothing it sees is
     * ever contacted.
     */
    await handleLeadSourcePoll(PAYLOAD);

    expect(claimLeadRow.mock.calls[0]![2]).toMatchObject({
      spreadsheetId: "sheet-1",
      tab: "Leads",
    });
  });

  it("cleans numbers with the same pipeline a bulk import uses", async () => {
    /* Reused rather than reimplemented: a lead source that normalised numbers
       differently from an import of the same file would be two answers to one
       question. "9876543210" is an Indian mobile with no country code. */
    await handleLeadSourcePoll(PAYLOAD);

    expect(claimLeadRow.mock.calls[0]![2]).toMatchObject({
      phoneE164: "+919876543210",
    });
  });

  it("counts a row it cannot get a number out of, with the reason", async () => {
    readSheetValues.mockResolvedValue({
      ok: true,
      rows: [["Name", "Mobile"], ["Asha", "not a number"], ["Ravi", ""]],
    });

    await handleLeadSourcePoll(PAYLOAD);

    expect(recordPoll.mock.calls[0]![3].counts).toMatchObject({
      seen: 2,
      sent: 0,
      rejected: 2,
      rejectReasons: { unparseable_phone: 1, missing_phone: 1 },
    });
  });

  it("advances the cursor to the end of the sheet, with an anchor", async () => {
    await handleLeadSourcePoll(PAYLOAD);

    const { cursor } = recordPoll.mock.calls[0]![3];

    expect(cursor.count).toBe(2);
    expect(cursor.anchor).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads only what is past the cursor when the sheet was appended to", async () => {
    /* The fast path. Nine thousand rows with two new ones must not be nine
       thousand claims per poll. */
    const { anchorHash } = await import("@whatsapp-os/core/leads-server");
    const anchor = anchorHash({ Name: "Asha", Mobile: "9876543210" });

    leadSourceForPoll.mockResolvedValue(
      binding({ cursorCount: 1, cursorAnchor: anchor }),
    );

    await handleLeadSourcePoll(PAYLOAD);

    expect(claimLeadRow).toHaveBeenCalledTimes(1);
    expect(claimLeadRow.mock.calls[0]![2]).toMatchObject({
      phoneE164: "+919876543211",
    });
  });
});

describe("a row that must not be sent twice", () => {
  it("counts a duplicate and carries on with the rest", async () => {
    /*
     * The unique index refusing a second claim, which happens routinely - a
     * rescan after a deletion re-examines rows already sent. It must not
     * abort the poll: the rows after it are genuinely new.
     */
    claimLeadRow.mockImplementationOnce(async () => {
      throw new DuplicateError("dup");
    });

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.sent).toBe(1);
    expect(recordPoll.mock.calls[0]![3].counts).toMatchObject({
      duplicate: 1,
      sent: 1,
    });
  });

  it("enqueues nothing for a duplicate", async () => {
    claimLeadRow.mockImplementation(async () => {
      throw new DuplicateError("dup");
    });

    await handleLeadSourcePoll(PAYLOAD);

    expect(add).not.toHaveBeenCalled();
  });

  it("does not swallow an error that is not a duplicate", async () => {
    /* A connection failure counted as a duplicate is a lead silently dropped
       and marked as already handled. */
    claimLeadRow.mockImplementation(async () => {
      throw new Error("connection reset");
    });

    await expect(handleLeadSourcePoll(PAYLOAD)).rejects.toThrow("connection reset");
  });

  it("enqueues nothing for a row that was skipped", async () => {
    claimLeadRow.mockImplementation(async () => ({
      kind: "skipped",
      rowId: "r1",
      reason: "opted out",
    }));

    await handleLeadSourcePoll(PAYLOAD);

    expect(add).not.toHaveBeenCalled();
    expect(recordPoll.mock.calls[0]![3].counts).toMatchObject({ skipped: 2, sent: 0 });
  });
});

describe("when the sheet cannot be read", () => {
  it("never advances the cursor", async () => {
    /* A failed read saw no rows. Advancing past rows nobody looked at is how
       leads are lost with nothing anywhere to say so. */
    readSheetValues.mockResolvedValue({
      ok: false,
      kind: "config",
      error: "Requested entity was not found.",
    });

    await handleLeadSourcePoll(PAYLOAD);

    expect(recordPoll).not.toHaveBeenCalled();
  });

  it("moves the binding to ERROR when the share is missing", async () => {
    /*
     * The single most common failure of this feature: the tenant pastes a URL
     * and never shares the sheet. Google answers 404, because to this service
     * account the spreadsheet genuinely does not exist. It must present as an
     * error on the page - silence is what it would otherwise be.
     */
    readSheetValues.mockResolvedValue({
      ok: false,
      kind: "config",
      error: "Requested entity was not found.",
    });

    await handleLeadSourcePoll(PAYLOAD);

    expect(recordPollFailure.mock.calls[0]![3]).toMatchObject({
      demote: true,
      error: "Requested entity was not found.",
    });
  });

  it("does not move the binding to ERROR on a timeout", async () => {
    /* Demoting on a blip teaches people to ignore the state that matters. */
    readSheetValues.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Timed out after 10000ms",
    });

    await handleLeadSourcePoll(PAYLOAD);

    expect(recordPollFailure.mock.calls[0]![3].demote).toBe(false);
  });
});

describe("quota", () => {
  it("backs off for as long as Google asked", async () => {
    readSheetValues.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Quota exceeded",
      details: { quotaExceeded: true, retryAfterMs: 45_000 },
    });

    await handleLeadSourcePoll(PAYLOAD);

    const call = recordPollFailure.mock.calls[0]![3];

    expect(call.demote).toBe(false);
    expect(call.backoffUntil!.getTime() - call.at.getTime()).toBe(45_000);
  });

  it("backs off a minute when Google does not say", async () => {
    /* Not the poll interval, which may be ten seconds. Re-asking a project
       that is already over its allowance is what keeps it over - and the
       allowance is shared with every other tenant's bindings. */
    readSheetValues.mockResolvedValue({
      ok: false,
      kind: "transient",
      error: "Quota exceeded",
      details: { quotaExceeded: true },
    });

    await handleLeadSourcePoll(PAYLOAD);

    const call = recordPollFailure.mock.calls[0]![3];

    expect(call.backoffUntil!.getTime() - call.at.getTime()).toBe(60_000);
  });

  it("reads nothing at all while the back-off is in force", async () => {
    leadSourceForPoll.mockResolvedValue(
      binding({ backoffUntil: new Date(Date.now() + 30_000) }),
    );

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("backing_off");
    expect(readSheetValues).not.toHaveBeenCalled();
  });

  it("polls again once the back-off has expired", async () => {
    leadSourceForPoll.mockResolvedValue(
      binding({ backoffUntil: new Date(Date.now() - 1_000) }),
    );

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("polled");
  });
});

describe("bindings that must not send", () => {
  it("does nothing for a paused binding", async () => {
    leadSourceForPoll.mockResolvedValue(binding({ status: "PAUSED" }));

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("not_active");
    expect(readSheetValues).not.toHaveBeenCalled();
  });

  it("does not read the sheet for a binding in error", async () => {
    /* It is waiting for somebody to fix the share. Polling it every thirty
       seconds spends quota to be told the same thing. */
    leadSourceForPoll.mockResolvedValue(binding({ status: "ERROR" }));

    expect((await handleLeadSourcePoll(PAYLOAD)).result).toBe("not_active");
  });

  it("refuses to send an unapproved template, once, before reading", async () => {
    /*
     * Checked here rather than per row. Meta re-checks on every send anyway,
     * but sending a rejected template to every new lead for a week would burn
     * the number's quality rating for no possible benefit.
     */
    leadSourceForPoll.mockResolvedValue(
      binding({ template: { ...TEMPLATE, status: "REJECTED" } }),
    );

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("template_not_approved");
    expect(add).not.toHaveBeenCalled();
    expect(recordPollFailure.mock.calls[0]![3].demote).toBe(true);
  });

  it("records a config it cannot read rather than throwing every thirty seconds", async () => {
    /* A poll job that throws on every attempt is a binding nobody can even
       look at, and the page has a sentence for this. */
    leadSourceForPoll.mockResolvedValue(binding({ actionConfig: { kind: "FLOW" } }));

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("misconfigured");
    expect(recordPollFailure).toHaveBeenCalled();
  });

  it("says so when Google Sheets is not connected at all", async () => {
    findFirstIntegration.mockResolvedValue(null);

    const result = await handleLeadSourcePoll(PAYLOAD);

    expect(result.result).toBe("unreadable");
    expect(recordPollFailure.mock.calls[0]![3].error).toContain("not connected");
  });

  it("reports a scheduler that outlived its binding", async () => {
    leadSourceForPoll.mockResolvedValue(null);

    expect((await handleLeadSourcePoll(PAYLOAD)).result).toBe("not_found");
  });
});
