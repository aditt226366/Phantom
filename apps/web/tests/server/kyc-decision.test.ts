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

const deleteCompanyKycDocuments = vi.fn(async (_id: string) => 3);
const getCompanyDetail = vi.fn(async (_id: string) => ({
  id: "company-1",
  name: "Northwind Traders",
}) as unknown);

vi.mock("@/lib/admin-db", () => ({
  decideKycDocument,
  deleteCompanyKycDocuments,
  getCompanyDetail,
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

/*
 * redirect() throws in real Next; this stub returns.
 *
 * That makes the mock WEAKER than reality, which is deliberate and is what
 * makes these assertions worth something: an action relying on the throw to
 * stop would keep running here, and the "refuses" tests would catch it. The
 * erase action uses `return redirect(...)` for exactly that reason.
 */
vi.mock("next/navigation", () => ({ redirect: () => undefined }));

const {
  approveDocumentAction,
  eraseCompanyDocumentsAction,
  rejectDocumentAction,
  revokeDocumentAction,
} = await import(
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
  deleteCompanyKycDocuments.mockClear().mockResolvedValue(3);
  getCompanyDetail
    .mockClear()
    .mockResolvedValue({ id: "company-1", name: "Northwind Traders" });
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

describe("erasing a company's documents", () => {
  /*
   * DPDP's right to erasure, and the one operation allowed to contradict the
   * append-only table. Irreversible, so the interesting assertions are all
   * about what stops it happening by accident.
   */
  it("erases when the typed name matches exactly", async () => {
    await eraseCompanyDocumentsAction(
      form({ companyId: "company-1", confirmName: "Northwind Traders" }),
    );

    expect(deleteCompanyKycDocuments).toHaveBeenCalledWith("company-1");
  });

  it("refuses a name that does not match", async () => {
    /*
     * The mistake this exists to stop is not a misclick - a confirm step
     * already covers that. It is confirming the WRONG company, which is what
     * happens with two tabs open, and only the typed name catches it.
     */
    await eraseCompanyDocumentsAction(
      form({ companyId: "company-1", confirmName: "Northwind" }),
    );

    expect(deleteCompanyKycDocuments, "erased on a near-match").not.toHaveBeenCalled();
  });

  it("refuses an empty confirmation", async () => {
    await eraseCompanyDocumentsAction(form({ companyId: "company-1" }));

    expect(deleteCompanyKycDocuments).not.toHaveBeenCalled();
  });

  it("accepts a name with stray whitespace, and nothing looser", async () => {
    /* Trimmed because a copy-paste picks up a trailing space and refusing that
       teaches people to distrust the control. Nothing else is forgiven. */
    await eraseCompanyDocumentsAction(
      form({ companyId: "company-1", confirmName: "  Northwind Traders  " }),
    );

    expect(deleteCompanyKycDocuments).toHaveBeenCalledTimes(1);

    deleteCompanyKycDocuments.mockClear();
    await eraseCompanyDocumentsAction(
      form({ companyId: "company-1", confirmName: "northwind traders" }),
    );

    expect(deleteCompanyKycDocuments, "matched case-insensitively").not.toHaveBeenCalled();
  });

  it("records the count after the delete, not before", async () => {
    /*
     * The documents are gone; this row is the only remaining evidence that
     * they existed and who removed them. So the number has to be what was
     * actually deleted rather than what was expected to be.
     */
    await eraseCompanyDocumentsAction(
      form({ companyId: "company-1", confirmName: "Northwind Traders" }),
    );

    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      action: "admin.kyc.documents.erased",
      metadata: { companyId: "company-1", documentsRemoved: 3 },
    });
  });

  it("does nothing for a company that does not exist", async () => {
    getCompanyDetail.mockResolvedValue(null);

    await eraseCompanyDocumentsAction(
      form({ companyId: "nope", confirmName: "anything" }),
    );

    expect(deleteCompanyKycDocuments).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});
