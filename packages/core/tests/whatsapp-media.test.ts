import { describe, expect, it, vi } from "vitest";
import { MAX_MEDIA_BYTES } from "../src/whatsapp/graph.ts";
import {
  downloadWhatsAppMedia,
  fetchWhatsAppMediaMetadata,
} from "../src/whatsapp/media.ts";

/**
 * The two calls that turn a media id into bytes.
 *
 * fetch is injected, so nothing here reaches the network. What is asserted is
 * the reading of Meta's answers and the one rule that protects this process
 * from them: the size cap, enforced on the bytes as they arrive rather than on
 * a header the sender chose.
 */

const SECRETS = {
  WHATSAPP_ACCESS_TOKEN: "tok-secret",
  WHATSAPP_PHONE_NUMBER_ID: "pn-1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A body delivered in fixed-size chunks, so the cap sees several reads. */
function streamOf(total: number, chunk = 64 * 1024): Response {
  let sent = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, total - sent);
        controller.enqueue(new Uint8Array(size).fill(7));
        sent += size;
      },
    }),
    { status: 200 },
  );
}

describe("reading a media id", () => {
  it("returns what a download needs, and sends the token as a header", async () => {
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        jsonResponse(200, {
          id: "media-1",
          url: "https://lookaside.example/abc",
          mime_type: "image/jpeg",
          sha256: "a".repeat(64),
          file_size: 2048,
        }),
    );

    const result = await fetchWhatsAppMediaMetadata(SECRETS, "media-1", fetchImpl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.metadata).toEqual({
      id: "media-1",
      url: "https://lookaside.example/abc",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
      fileSize: 2048,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    /* Never ?access_token=, which would put it in Meta's logs and ours. */
    expect(String(url)).not.toContain("tok-secret");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer tok-secret",
    );
  });

  it("accepts a file_size Meta sent as a string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        url: "https://lookaside.example/abc",
        mime_type: "image/jpeg",
        sha256: "b".repeat(64),
        file_size: "4096",
      }),
    );

    const result = await fetchWhatsAppMediaMetadata(SECRETS, "media-1", fetchImpl);

    expect(result.ok && result.metadata.fileSize).toBe(4096);
  });

  it("refuses an answer with no sha256, rather than storing under an empty hash", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        url: "https://lookaside.example/abc",
        mime_type: "image/jpeg",
        file_size: 2048,
      }),
    );

    const result = await fetchWhatsAppMediaMetadata(SECRETS, "media-1", fetchImpl);

    expect(result.ok).toBe(false);
    /*
     * transient, not config: config demotes the integration badge, and the
     * credential that just authenticated this call is not the problem.
     */
    expect(result.ok === false && result.kind).toBe("transient");
  });

  it("reports a refused credential as auth", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { message: "Invalid OAuth token", code: 190 } }),
    );

    const result = await fetchWhatsAppMediaMetadata(SECRETS, "media-1", fetchImpl);

    expect(result.ok === false && result.kind).toBe("auth");
  });

  it("does not call Meta at all without a token", async () => {
    const fetchImpl = vi.fn();

    const result = await fetchWhatsAppMediaMetadata({}, "media-1", fetchImpl);

    expect(result.ok === false && result.kind).toBe("config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("downloading the bytes", () => {
  it("returns the whole file when it is under the cap", async () => {
    const fetchImpl = vi.fn(async () => streamOf(200_000));

    const result = await downloadWhatsAppMedia(
      SECRETS,
      "https://lookaside.example/abc",
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.byteSize).toBe(200_000);
    expect(result.ok && result.bytes.byteLength).toBe(200_000);
  });

  it("stops a file that crosses the cap instead of buffering it", async () => {
    /*
     * The rule that keeps one oversized file from becoming as many as the
     * concurrency allows, each held in memory. content-length is not consulted
     * anywhere: it is a claim by the sender, and a response that omits it or
     * lies would sail past a header check.
     */
    let cancelled = false;
    let produced = 0;

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 512 * 1024;
              controller.enqueue(new Uint8Array(512 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );

    const result = await downloadWhatsAppMedia(
      SECRETS,
      "https://lookaside.example/big",
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("too_large");

    /*
     * Abandoned near the limit rather than after reading an unbounded body.
     * A couple of chunks of slack, because a ReadableStream may pull ahead of
     * the reader - what is being asserted is bounded, not exact.
     */
    expect(produced).toBeLessThanOrEqual(MAX_MEDIA_BYTES + 2 * 1024 * 1024);
    expect(cancelled, "the transfer was left running").toBe(true);
  });

  it("treats an expired link as transient, because a retry re-reads the id", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 }));

    const result = await downloadWhatsAppMedia(
      SECRETS,
      "https://lookaside.example/stale",
      fetchImpl,
    );

    expect(result.ok === false && result.kind).toBe("transient");
  });

  it("reports a rejected token as auth", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));

    const result = await downloadWhatsAppMedia(
      SECRETS,
      "https://lookaside.example/abc",
      fetchImpl,
    );

    expect(result.ok === false && result.kind).toBe("auth");
  });

  it("keeps the token out of a network error message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED using tok-secret");
    });

    const result = await downloadWhatsAppMedia(
      SECRETS,
      "https://lookaside.example/abc",
      fetchImpl,
    );

    /* Narrowed explicitly: the failure union includes too_large, which carries
       a size rather than a message. */
    if (result.ok || result.kind === "too_large") {
      throw new Error("expected a failure carrying a message");
    }

    expect(result.error).not.toContain("tok-secret");
  });
});
