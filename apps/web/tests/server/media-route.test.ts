import { PROTECTED_PREFIXES } from "@/lib/nav";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Serving a file a customer sent.
 *
 * The store underneath is proved against a real database in
 * packages/db/tests/media-store.test.ts, including the chunked read. What is
 * asserted here is the route's contract: who is allowed to ask, what it says
 * about caching, and that it never describes a row belonging to somebody else.
 */

const stat = vi.fn<
  (db: unknown, companyId: string, key: string) => Promise<unknown>
>();
const get = vi.fn<
  (companyId: string, key: string) => Promise<ReadableStream | null>
>();

/** Rises when requireSession is called, so its absence is observable. */
let sessionChecked = 0;
let signedIn = true;

vi.mock("@whatsapp-os/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/db")>()),
  withCompany: async (companyId: string, cb: (db: unknown, id: string) => unknown) =>
    cb({}, companyId),
  mediaStore: { stat, get },
}));

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => {
    sessionChecked++;
    if (!signedIn) {
      /* What redirect() throws in a route handler. The route must not continue
         past this line, which is the whole point of R6. */
      const error = new Error("NEXT_REDIRECT;/sign-in");
      (error as Error & { digest?: string }).digest = "NEXT_REDIRECT;/sign-in";
      throw error;
    }
    return { companyId: "company-1", userId: "u1", sessionId: "s1" };
  },
}));

const { GET } = await import("@/app/api/media/[mediaId]/route");

const SHA = "a".repeat(64);
const ETAG = `"${SHA}"`;
const ctx = { params: Promise.resolve({ mediaId: "media-1" }) };

function stored(over: Record<string, unknown> = {}) {
  return {
    key: "media-1",
    sha256: SHA,
    mimeType: "image/jpeg",
    fileName: "holiday.jpg",
    byteSize: 2048,
    state: "STORED",
    skippedReason: null,
    ...over,
  };
}

function streamOf(bytes = 2048): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/media/media-1", { headers });
}

beforeEach(() => {
  stat.mockReset();
  get.mockReset();
  sessionChecked = 0;
  signedIn = true;

  stat.mockResolvedValue(stored());
  get.mockResolvedValue(streamOf());
});

describe("R6 - the session check is the only boundary", () => {
  it("is not behind the proxy guard, which is why the route must check", () => {
    /*
     * isProtected() is false for /api/*, deliberately: the webhook lives under
     * it and must stay reachable by Meta. So this path gets none of the
     * redirect protection every tenant page has.
     */
    const path = "/api/media/media-1";

    const guarded = PROTECTED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );

    expect(guarded, "the media route is behind the proxy guard").toBe(false);
  });

  it("refuses a signed-out request, and reads nothing", async () => {
    signedIn = false;

    /*
     * Asserted rather than trusted, as R6 requires. Without this the route
     * would be one forgotten line away from serving a stranger's customer's
     * photograph, and nothing else in the system would notice.
     */
    await expect(GET(request(), ctx)).rejects.toThrow(/NEXT_REDIRECT/);

    expect(stat, "the store was reached without a session").not.toHaveBeenCalled();
    expect(get, "bytes were read without a session").not.toHaveBeenCalled();
  });

  it("checks the session before anything else on every request", async () => {
    await GET(request(), ctx);

    expect(sessionChecked).toBe(1);
  });

  it("scopes the read to the session's company, not to anything in the URL", async () => {
    await GET(request(), ctx);

    /* A media id is a cuid, but unguessable is not an access control. */
    expect(stat.mock.calls[0]![1]).toBe("company-1");
    expect(get.mock.calls[0]![0]).toBe("company-1");
  });
});

describe("serving the bytes", () => {
  it("streams with a length and a type", async () => {
    const response = await GET(request(), ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    /* From byte_size, which a CHECK ties to octet_length(bytes). */
    expect(response.headers.get("content-length")).toBe("2048");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("uses the sha256 as a strong ETag", async () => {
    const response = await GET(request(), ctx);

    /* Quoted and unprefixed. A W/ prefix makes it weak, and weak validators
       cannot be used for range requests. */
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(response.headers.get("etag")).not.toContain("W/");
  });

  it("answers 304 when the client already has it", async () => {
    const response = await GET(request({ "if-none-match": ETAG }), ctx);

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(ETAG);
    /* No body, and no read: the point is not touching the bytes at all. */
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Cache-Control", () => {
  it("is private, and is not public", async () => {
    const response = await GET(request(), ctx);
    const header = response.headers.get("cache-control") ?? "";

    /*
     * Both halves, and the second is the one that matters. A later edit adding
     * a long max-age for performance could produce
     * "private, public, max-age=31536000" - which keeps the word private and
     * satisfies a contains-only check while meaning the opposite: a shared
     * cache storing one tenant's photograph and serving it to the next request
     * for the same URL.
     */
    expect(header).toContain("private");
    expect(header, "a shared cache may store tenant media").not.toContain("public");
  });

  it("says private on a 304 too", async () => {
    const response = await GET(request({ "if-none-match": ETAG }), ctx);
    const header = response.headers.get("cache-control") ?? "";

    /* The revalidation response has to repeat the directive, or a cache that
       stored it on the 200 may re-file it under different rules. */
    expect(header).toContain("private");
    expect(header).not.toContain("public");
  });
});

describe("what it will not serve", () => {
  it("404s a media id this company does not have", async () => {
    stat.mockResolvedValue(null);

    const response = await GET(request(), ctx);

    /* Rule 6. A 403 would confirm the row exists. */
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("404s a file that was too big to keep", async () => {
    stat.mockResolvedValue(
      stored({ state: "SKIPPED", skippedReason: "over_max_size" }),
    );

    const response = await GET(request(), ctx);

    /*
     * Indistinguishable from absent, on purpose. The thread already says
     * "6.2 MB, not stored" from the row; a distinct code here would describe
     * somebody else's storage to whoever probed for it.
     */
    expect(response.status).toBe(404);
  });

  it("404s when the bytes vanish between the stat and the read", async () => {
    get.mockResolvedValue(null);

    expect((await GET(request(), ctx)).status).toBe(404);
  });
});

describe("the filename", () => {
  it("cannot inject a header", async () => {
    /* It comes off a customer's handset. A newline splits the response and a
       quote closes the parameter early. */
    stat.mockResolvedValue(
      stored({ fileName: 'evil"\r\nSet-Cookie: session=stolen' }),
    );

    const response = await GET(request(), ctx);
    const disposition = response.headers.get("content-disposition") ?? "";

    /*
     * The property is that no LINE BREAK and no closing quote survive - those
     * are what turn a filename into a second header or end the parameter
     * early. The words themselves surviving as text inside the quoted value
     * are harmless, and asserting their absence would be testing prudishness
     * rather than injection.
     */
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(
      disposition.match(/"/g) ?? [],
      "the quoted value was closed early",
    ).toHaveLength(2);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("falls back to inline when there is no usable name", async () => {
    stat.mockResolvedValue(stored({ fileName: null }));

    expect((await GET(request(), ctx)).headers.get("content-disposition")).toBe(
      "inline",
    );
  });
});
