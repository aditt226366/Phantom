import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approve, reject and revoke.
 *
 * Three things here fail quietly if they are wrong, which is why this file
 * exists rather than leaving it to the page:
 *
 *   1. A rejection with no reason. The tenant is told to send another document
 *      and not what was wrong with this one, so they send the same one again -
 *      a loop that looks like a working system to everybody involved.
 *   2. A decision that lost a race. Two operators open the same document and
 *      both click; without the status guard the second silently overwrites the
 *      first verdict and the audit log shows two decisions with no sign one
 *      of them did not happen.
 *   3. Revoke writing the wrong thing. It has to land as REJECTED to close the
 *      gate, and be recorded as a REVOCATION so the log can tell "never
 *      accepted" from "accepted and withdrawn".
 */

const decideKycDocument = vi.fn(
  async (_input: Record<string, unknown>) => true,
);
const getKycDocument = vi.fn(async (_id: string) => DOCUMENT as unknown);
const writeAdminAudit = vi.fn(
  async (_entry: Record<string, unknown>) => undefined,
);

const DOCUMENT = {
  id: "doc-1",
  companyId: "company-1",
  kind: "GST",
  status: "PENDING",
};

vi.mock("@/lib/admin-db", () => ({
  decideKycDocument,
  getKycDocument,
  writeAdminAudit,
}));

vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => ({
    adminUserId: "admin-1",
    username: "operator",
    sessionId: "s1",
  }),
  assertAdminCsrf: async () => undefined,
}));

vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: "203.0.113.9" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

/* redirect() throws in real Next. Swallowed so the assertions after it run. */
vi.mock("next/navigation", () => ({ redirect: () => undefined }));

const { approveDocumentAction, rejectDocumentAction, revokeDocumentAction } =
  await import(
    "@/app/(admin)/admin/(console)/companies/[id]/documents/actions"
  );

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  decideKycDocument.mockClear().mockResolvedValue(true);
  getKycDocument.mockClear().mockResolvedValue(DOCUMENT);
  writeAdminAudit.mockClear();
});

describe("approving", () => {
  it("records the verdict without demanding an explanation", async () => {
    /* Requiring a note on an approval would be busywork on the path an
       operator walks dozens of times a day. */
    await approveDocumentAction(form({ documentId: "doc-1" }));

    expect(decideKycDocument).toHaveBeenCalledTimes(1);
    expect(decideKycDocument.mock.calls[0]?.[0]).toMatchObject({
      status: "APPROVED",
      reviewNote: null,
    });
  });
});

describe("rejecting", () => {
  it("refuses to record a rejection with no reason", async () => {
    /*
     * The form marks the field required; this is the half a POST cannot skip.
     * A rejection with no reason is a dead end wearing a status chip.
     */
    await rejectDocumentAction(form({ documentId: "doc-1", reviewNote: "" }));

    expect(decideKycDocument, "rejected with no reason").not.toHaveBeenCalled();
  });

  it("refuses a reason that is only whitespace", async () => {
    await rejectDocumentAction(form({ documentId: "doc-1", reviewNote: "   " }));

    expect(decideKycDocument).not.toHaveBeenCalled();
  });

  it("records the reason the tenant will read", async () => {
    await rejectDocumentAction(
      form({ documentId: "doc-1", reviewNote: "The scan is cut off at the edge." }),
    );

    expect(decideKycDocument.mock.calls[0]?.[0]).toMatchObject({
      status: "REJECTED",
      reviewNote: "The scan is cut off at the edge.",
    });
  });
});

describe("revoking", () => {
  it("lands as REJECTED so the gate actually closes", async () => {
    /*
     * There is no REVOKED status, deliberately - it would give the gate two
     * ways to spell one closed door. What matters is that the write is the one
     * canUseFeatures refuses on.
     */
    getKycDocument.mockResolvedValue({ ...DOCUMENT, status: "APPROVED" });

    await revokeDocumentAction(
      form({ documentId: "doc-1", reviewNote: "Superseded by a police notice." }),
    );

    expect(decideKycDocument.mock.calls[0]?.[0]).toMatchObject({
      status: "REJECTED",
      expectedStatus: "APPROVED",
    });
  });

  it("is recorded as a revocation, not as a rejection", async () => {
    /*
     * The status collapses and the record does not. "Never accepted" and
     * "accepted, then withdrawn" are different events, and the second is the
     * one an incident review is looking for.
     */
    getKycDocument.mockResolvedValue({ ...DOCUMENT, status: "APPROVED" });

    await revokeDocumentAction(
      form({ documentId: "doc-1", reviewNote: "Superseded." }),
    );

    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      action: "admin.kyc.document.revoked",
      metadata: { from: "APPROVED", to: "REJECTED" },
    });
  });

  it("demands a reason, as a rejection does", async () => {
    /* A tenant whose account stops working is owed an explanation more than
       one whose upload was refused - they had it, and now they do not. */
    getKycDocument.mockResolvedValue({ ...DOCUMENT, status: "APPROVED" });

    await revokeDocumentAction(form({ documentId: "doc-1", reviewNote: "" }));

    expect(decideKycDocument).not.toHaveBeenCalled();
  });
});

describe("two operators at once", () => {
  it("guards the write on the status the operator was looking at", async () => {
    await approveDocumentAction(form({ documentId: "doc-1" }));

    expect(decideKycDocument.mock.calls[0]?.[0]).toMatchObject({
      expectedStatus: "PENDING",
    });
  });

  it("records a decision that did not land, rather than dropping it", async () => {
    /*
     * Another operator got there first. The write is a no-op, which is the
     * point of the guard - but the attempt is still a decision somebody made,
     * and its absence from the log would be the confusing part.
     */
    decideKycDocument.mockResolvedValue(false);

    await approveDocumentAction(form({ documentId: "doc-1" }));

    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      metadata: { applied: false },
    });
  });
});

describe("a document that is not there", () => {
  it("does nothing at all", async () => {
    getKycDocument.mockResolvedValue(null);

    await approveDocumentAction(form({ documentId: "nope" }));

    expect(decideKycDocument).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});
