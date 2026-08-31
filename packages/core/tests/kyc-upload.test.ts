import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_KYC_UPLOAD_BYTES,
  readPdfUpload,
  safeDocumentFilename,
} from "../src/kyc/upload.ts";

/**
 * Reading an upload, and refusing it before it is resident.
 *
 * Both halves are the kind of check that fails silently when it fails: a cap
 * applied after the read still passes every test written against small files,
 * and a file-type check that trusts the extension passes every test written
 * with honestly-named ones. So the fixtures here are deliberately dishonest.
 */

/** A stream that hands over exactly these chunks. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pdfOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(bytes("%PDF-").slice(0, Math.min(5, size)));
  return out;
}

describe("the file type", () => {
  it("accepts bytes that begin %PDF-", async () => {
    const result = await readPdfUpload(streamOf(bytes("%PDF-1.4 hello")));

    expect(result.ok).toBe(true);
  });

  it("refuses HTML however the browser labelled it", async () => {
    /*
     * The realistic attack, and the reason the extension and the Content-Type
     * are never consulted: both are attacker-supplied. Only the content is
     * evidence.
     */
    const result = await readPdfUpload(
      streamOf(bytes("<!doctype html><script>alert(1)</script>")),
    );

    expect(result).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("refuses a PDF header that starts four bytes in", async () => {
    /* Prefixed, not contained. A check written with indexOf would accept this
       and accept a PDF header buried in a megabyte of anything else. */
    const smuggled = new Uint8Array(64);
    smuggled.set(bytes("%PDF-"), 4);

    const result = await readPdfUpload(streamOf(smuggled));

    expect(result).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("reads a header split across chunk boundaries", async () => {
    /*
     * A client may send the first byte on its own, and a slow uplink does. A
     * check that looked only at chunks[0] would work on every browser anyone
     * tests with and refuse a real PDF in production.
     */
    const result = await readPdfUpload(
      streamOf(bytes("%"), bytes("PD"), bytes("F-1.4 rest")),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a file shorter than the magic number", async () => {
    const result = await readPdfUpload(streamOf(bytes("%P")));

    expect(result).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("refuses an empty upload as empty, not as a bad file", async () => {
    /* A form submitted with nothing selected. "Choose a PDF" is the wrong
       advice for it; "you did not attach anything" is the right one. */
    const result = await readPdfUpload(streamOf());

    expect(result).toEqual({ ok: false, reason: "empty" });
  });
});

describe("the size cap", () => {
  it("accepts a document at exactly the limit", async () => {
    const result = await readPdfUpload(streamOf(pdfOf(MAX_KYC_UPLOAD_BYTES)));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.byteSize).toBe(MAX_KYC_UPLOAD_BYTES);
  });

  it("refuses one byte more", async () => {
    const result = await readPdfUpload(streamOf(pdfOf(MAX_KYC_UPLOAD_BYTES + 1)));

    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("stops reading rather than finishing and discarding", async () => {
    /*
     * The assertion that separates a cap from a memory exhaustion vector.
     *
     * The stream counts how many chunks it was asked for. A cap applied after
     * the read would pull all forty - four megabytes past the limit - and
     * return the same refusal, so asserting only the verdict would pass for
     * an implementation that reads everything an attacker sends.
     */
    let pulled = 0;
    let cancelled = false;

    const chunk = new Uint8Array(512 * 1024);
    chunk.set(bytes("%PDF-"));

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        /* 40 chunks of 512 KiB is 20 MiB, four times the cap. */
        if (pulled > 40) {
          controller.close();
          return;
        }
        controller.enqueue(pulled === 1 ? chunk : new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await readPdfUpload(stream);

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled, "the reader was not cancelled").toBe(true);
    expect(
      pulled,
      `read ${pulled} chunks; the cap is crossed at 11`,
    ).toBeLessThanOrEqual(12);
  });

  it("refuses a large non-PDF after one chunk, not after five megabytes", async () => {
    /*
     * Ordering, not correctness: both checks refuse this file. What is being
     * asserted is that the cheap one runs first, so a 5 MB HTML file costs one
     * chunk rather than the whole allowance.
     */
    let pulled = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 10) {
          controller.close();
          return;
        }
        controller.enqueue(
          pulled === 1 ? bytes("<!doctype html>".padEnd(512 * 1024, " ")) : new Uint8Array(512 * 1024),
        );
      },
    });

    const result = await readPdfUpload(stream);

    expect(result).toEqual({ ok: false, reason: "not_a_pdf" });
    expect(pulled, "kept reading a file it had already refused").toBe(1);
  });
});

describe("what comes back", () => {
  it("carries the bytes, the size and their hash", async () => {
    const content = bytes("%PDF-1.4 northwind");

    const result = await readPdfUpload(streamOf(content));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.bytes).toEqual(content);
    expect(result.byteSize).toBe(content.byteLength);
    /* Computed over the assembled bytes, which is what the download route
       serves as its ETag - so a hash of anything else is a cache that never
       validates. */
    expect(result.sha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  });

  it("reassembles chunks in order", async () => {
    const result = await readPdfUpload(
      streamOf(bytes("%PDF-"), bytes("one"), bytes("two")),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-onetwo");
    }
  });
});

describe("the filename", () => {
  it("keeps an ordinary one intact", () => {
    expect(safeDocumentFilename("northwind-gst.pdf")).toBe("northwind-gst.pdf");
  });

  it("strips a newline, which would split the response", () => {
    /*
     * The header injection. Everything after the CRLF would be read as header
     * syntax by the client, which is how a download turns into a response the
     * uploader wrote.
     */
    const cleaned = safeDocumentFilename("gst.pdf\r\nSet-Cookie: a=b");

    expect(cleaned).not.toContain("\r");
    expect(cleaned).not.toContain("\n");
    expect(cleaned).toBe("gst.pdfSet-Cookie ab");
  });

  it("strips a double quote, which would close the parameter early", () => {
    const cleaned = safeDocumentFilename('gst".pdf');

    expect(cleaned).not.toContain('"');
  });

  it("returns null when nothing survives, rather than an empty name", () => {
    /* filename="" makes some browsers save the file under the URL's last
       segment, which here is an opaque cuid. The caller sends no filename. */
    expect(safeDocumentFilename("///")).toBeNull();
    expect(safeDocumentFilename(null)).toBeNull();
    expect(safeDocumentFilename("")).toBeNull();
  });

  it("truncates a name too long for a header", () => {
    const long = `${"a".repeat(500)}.pdf`;

    expect(safeDocumentFilename(long)?.length).toBeLessThanOrEqual(100);
  });
});
