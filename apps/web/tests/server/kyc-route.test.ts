import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Serving a verification document to the platform operator.
 *
 * The chunked read underneath is proved against a real database in
 * packages/db. What is asserted here is the route's contract: who is allowed
 * to ask, that every access is recorded, and that the headers do not leave an
 * identity document somewhere it can be read again later.
 *
 * The authorization check is the one that would fail silently. `/api/*` is
 * outside proxy.ts's protected set by design - the webhook lives there - so
 * requireAdminSession() in this file is not defence in depth, it is the only
 * thing between an anonymous GET and somebody's Aadhaar card. A version of
 * this route that forgot it would work perfectly for every signed-in operator
 * and be wide open.
 */

const getKycDocument = vi.fn();
const readKycDocumentBytes = vi.fn();
/* Typed to the real signature so `mock.calls[0][0]` is the entry rather than an
   index into an empty tuple - vi.fn infers `[]` from a zero-argument impl. */
const writeAdminAudit = vi.fn(async (_entry: Record<string, unknown>) => undefined);

/** Rises when requireAdminSession is called, so its absence is observable. */
let sessionChecked = 0;
let signedIn = true;

vi.mock("@/lib/admin-db", () => ({
  getKycDocument,
  readKycDocumentBytes,
  writeAdminAudit,
}));

vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: "203.0.113.9" }),
}));

vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => {
    sessionChecked++;
    if (!signedIn) {
      /* What redirect() throws in a route handler. The route must not continue
         past this line, which is the whole point. */
      const error = new Error("NEXT_REDIRECT;/admin/sign-in");
      (error as Error & { digest?: string }).digest =
        "NEXT_REDIRECT;/admin/sign-in";
      throw error;
    }
    return { adminUserId: "admin-1", username: "operator", sessionId: "s1" };
  },
}));

const { GET } = await import("@/app/api/admin/kyc-documents/[documentId]/route");

const SHA = "b".repeat(64);
const ETAG = `"${SHA}"`;
const ctx = { params: Promise.resolve({ documentId: "doc-1" }) };

const DOCUMENT = {
  id: "doc-1",
  companyId: "company-1",
  kind: "AADHAAR",
  status: "PENDING",
  sha256: SHA,
  mimeType: "application/pdf",
  originalFilename: "priya-aadhaar.pdf",
  byteSize: 5,
  uploadedAt: new Date("2026-02-11T05:15:00Z"),
  reviewedAt: null,
  reviewedByUsername: null,
  reviewNote: null,
};

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function request(url = "http://localhost/api/admin/kyc-documents/doc-1", headers = {}) {
  return new Request(url, { headers });
}

beforeEach(() => {
  sessionChecked = 0;
  signedIn = true;
  getKycDocument.mockReset().mockResolvedValue(DOCUMENT);
  readKycDocumentBytes.mockReset().mockResolvedValue(streamOf("%PDF-"));
  writeAdminAudit.mockClear();
});

describe("who may ask", () => {
  it("requires an admin session before reading anything", async () => {
    signedIn = false;

    await expect(GET(request(), ctx)).rejects.toThrow(/NEXT_REDIRECT/);

    expect(sessionChecked).toBe(1);
    expect(
      getKycDocument,
      "looked up a document before checking the session",
    ).not.toHaveBeenCalled();
    expect(readKycDocumentBytes).not.toHaveBeenCalled();
  });

  it("checks the session on every request", async () => {
    await GET(request(), ctx);
    await GET(request(), ctx);

    expect(sessionChecked).toBe(2);
  });
});

describe("what it says about a document that is not there", () => {
  it("answers 404 for an unknown id", async () => {
    getKycDocument.mockResolvedValue(null);

    const response = await GET(request(), ctx);

    expect(response.status).toBe(404);
  });

  it("answers 404 when the bytes vanish between the two reads", async () => {
    /* An erasure request landing mid-request. Same answer as never having
       existed, rather than a 500 that describes the race. */
    readKycDocumentBytes.mockResolvedValue(null);

    const response = await GET(request(), ctx);

    expect(response.status).toBe(404);
  });
});

describe("the audit trail", () => {
  it("records a view before the bytes are streamed", async () => {
    await GET(request(), ctx);

    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      adminUserId: "admin-1",
      action: "admin.kyc.document.view",
      metadata: { documentId: "doc-1", companyId: "company-1", kind: "AADHAAR" },
    });
  });

  it("distinguishes a download from a view", async () => {
    await GET(
      request("http://localhost/api/admin/kyc-documents/doc-1?download=1"),
      ctx,
    );

    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      action: "admin.kyc.document.download",
    });
  });

  it("records a look that the browser served from its own cache", async () => {
    /*
     * A 304 means the operator is displaying the document. Treating that as
     * "did not look" would make the log under-count the operator who looks
     * most often, which is the opposite of what an incident review needs.
     */
    const response = await GET(request(undefined, { "if-none-match": ETAG }), ctx);

    expect(response.status).toBe(304);
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
    expect(writeAdminAudit.mock.calls[0]?.[0]).toMatchObject({
      metadata: { cached: true },
    });
  });
});

describe("the headers", () => {
  it("keeps the document out of every shared cache", async () => {
    const response = await GET(request(), ctx);
    const cacheControl = response.headers.get("cache-control") ?? "";

    /*
     * Asserted in both directions on purpose: "private, public" would satisfy
     * a contains-only check while meaning the opposite. A proxy that stored
     * one tenant's Aadhaar card and served it to the next request for this URL
     * would be a disclosure through infrastructure this app does not control.
     */
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
  });

  it("sends a strong ETag that is the content hash", async () => {
    const response = await GET(request(), ctx);

    expect(response.headers.get("etag")).toBe(ETAG);
    /* W/ would make it weak, and a weak validator cannot serve a range. */
    expect(response.headers.get("etag")).not.toMatch(/^W\//);
  });

  it("sends the stored length, not a guess", async () => {
    const response = await GET(request(), ctx);

    expect(response.headers.get("content-length")).toBe("5");
  });

  it("refuses to let a browser sniff the type", async () => {
    /*
     * A PDF is a scriptable format uploaded by a stranger, and this is the
     * admin panel's origin - the one holding the session that can read every
     * tenant's documents.
     */
    const response = await GET(request(), ctx);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("switches to an attachment when a download is asked for", async () => {
    const inline = await GET(request(), ctx);
    const attached = await GET(
      request("http://localhost/api/admin/kyc-documents/doc-1?download=1"),
      ctx,
    );

    expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(attached.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("strips a filename that would split the response", async () => {
    /*
     * The name came from whoever uploaded the file. A newline ends the header
     * and everything after it is read as header syntax by the client.
     */
    getKycDocument.mockResolvedValue({
      ...DOCUMENT,
      originalFilename: 'evil".pdf\r\nSet-Cookie: a=b',
    });

    const disposition = (await GET(request(), ctx)).headers.get(
      "content-disposition",
    );

    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("Set-Cookie: a=b");
  });

  it("sends no filename at all rather than an empty one", async () => {
    /* filename="" makes some browsers save the file under the URL's last
       segment, which here is an opaque cuid. */
    getKycDocument.mockResolvedValue({ ...DOCUMENT, originalFilename: "///" });

    expect((await GET(request(), ctx)).headers.get("content-disposition")).toBe(
      "inline",
    );
  });
});
