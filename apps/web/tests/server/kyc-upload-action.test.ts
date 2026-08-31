import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The upload action's refusals, which are the half a page cannot enforce.
 *
 * The page hides the control on an approved document. That is a convenience:
 * a POST does not have to come from the page, and an action that trusted the
 * absence of a button would let anyone with a session un-verify their own
 * company - or somebody else's, if the scope were ever wrong.
 *
 * The database is mocked. What is under test is the order of operations in the
 * action; the storage and the validation have their own tests against real
 * constraints in packages/db and packages/core.
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

/** What currentKycDocuments will answer. Set per test. */
let current: Record<string, { status: string } | null> = {
  GST: null,
  PAN: null,
  AADHAAR: null,
};

/* Typed to the real signature so `mock.calls[0][2]` is the input object rather
   than an index into an empty tuple - vi.fn infers `[]` from a zero-arg impl. */
const putKycDocument = vi.fn(
  async (_db: unknown, _companyId: string, _input: unknown) => "doc-1",
);

vi.mock("@whatsapp-os/db", () => ({
  withCompany: async (companyId: string, fn: (db: unknown, id: string) => unknown) =>
    fn({}, companyId),
  currentKycDocuments: async () => current,
  putKycDocument,
}));

const { uploadKycDocumentAction } = await import(
  "@/app/(app)/profile/documents/actions"
);

/** A form carrying one file, the way the browser sends it. */
function upload(kind: string, content: string, name = "gst.pdf"): FormData {
  const form = new FormData();
  form.set("kind", kind);
  form.set(
    "file",
    new File([new TextEncoder().encode(content)], name, {
      /* The browser's claim, deliberately application/pdf even in the tests
         where the content is not one. That is the whole point: the type is
         decided from the bytes, so a lying Content-Type must not help. */
      type: "application/pdf",
    }),
  );
  return form;
}

beforeEach(() => {
  putKycDocument.mockClear();
  current = { GST: null, PAN: null, AADHAAR: null };
});

describe("what it stores", () => {
  it("files a real PDF", async () => {
    const result = await uploadKycDocumentAction({}, upload("GST", "%PDF-1.4 x"));

    expect(result.success).toBeTruthy();
    expect(putKycDocument).toHaveBeenCalledTimes(1);
  });

  it("stores our finding as the mime type, never the browser's claim", async () => {
    /*
     * file.type is whatever the client volunteered, and readPdfUpload has just
     * established what the file actually is. Storing the claim would put a
     * contradiction in the row and then serve it as a Content-Type on the
     * download - which is how a browser gets talked into sniffing.
     */
    await uploadKycDocumentAction({}, upload("PAN", "%PDF-1.4 x", "pan.pdf"));

    expect(putKycDocument.mock.calls[0]?.[2]).toMatchObject({
      mimeType: "application/pdf",
      kind: "PAN",
    });
  });
});

describe("what it refuses", () => {
  it("refuses a file that is not a PDF, whatever it is called", async () => {
    const result = await uploadKycDocumentAction(
      {},
      upload("GST", "<!doctype html><script>alert(1)</script>", "gst.pdf"),
    );

    expect(result.message).toMatch(/not a PDF/i);
    expect(putKycDocument, "stored a non-PDF").not.toHaveBeenCalled();
  });

  it("refuses a replacement for an approved document", async () => {
    /*
     * The assertion this file exists for. The page hides the control, and the
     * page is not the boundary.
     *
     * Why it is locked: a re-upload over an approval writes a PENDING row, the
     * gate shuts, and nothing the tenant did looked like turning the product
     * off.
     */
    current = { GST: { status: "APPROVED" }, PAN: null, AADHAAR: null };

    const result = await uploadKycDocumentAction({}, upload("GST", "%PDF-1.4 x"));

    expect(result.message).toMatch(/already approved/i);
    expect(putKycDocument, "replaced an approved document").not.toHaveBeenCalled();
  });

  it("allows a replacement while pending or rejected", async () => {
    for (const status of ["PENDING", "REJECTED"]) {
      putKycDocument.mockClear();
      current = { GST: { status }, PAN: null, AADHAAR: null };

      const result = await uploadKycDocumentAction({}, upload("GST", "%PDF-1.4 x"));

      expect(result.success, `${status} was refused`).toBeTruthy();
      expect(putKycDocument).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a kind it does not collect", async () => {
    /*
     * The value comes from a hidden input, which is to say from the client. An
     * unchecked cast would hand an arbitrary string to an enum column - a 500
     * from a query error rather than a refusal.
     */
    const result = await uploadKycDocumentAction({}, upload("PASSPORT", "%PDF-1.4"));

    expect(result.message).toMatch(/not a document we collect/i);
    expect(putKycDocument).not.toHaveBeenCalled();
  });

  it("refuses a form with no file attached", async () => {
    const form = new FormData();
    form.set("kind", "GST");

    const result = await uploadKycDocumentAction({}, form);

    expect(result.message).toMatch(/no file/i);
    expect(putKycDocument).not.toHaveBeenCalled();
  });
});
