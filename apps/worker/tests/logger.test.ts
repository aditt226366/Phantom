import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/logger.ts";

/**
 * The wiring, not the helper.
 *
 * redact.test.ts proves redactKeys removes secrets. This proves the logger
 * actually calls it — which is a different claim, and the one this project
 * keeps getting wrong: a correct, exported, well-tested helper that nothing
 * invokes looks exactly like a solved problem in every place you would think
 * to check.
 *
 * So these go through log.error() and assert on the line that reaches the
 * console, with no reference to the redactor at all. If the import were
 * deleted from emit(), every test below fails and none of redact.test.ts does.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxSuperSecretAccessToken";

/** The JSON the logger actually wrote. */
function captureLine(emit: () => void): string {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);

  try {
    emit();
    const call = spy.mock.calls[0] ?? out.mock.calls[0];
    expect(call, "the logger wrote nothing").toBeDefined();
    return String(call?.[0]);
  } finally {
    spy.mockRestore();
    out.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log.error", () => {
  it("still writes a usable line", () => {
    /* If redaction broke the log format, everything below would pass while
       producing something unreadable. Assert the shape first. */
    const line = captureLine(() => {
      log.error("job failed", { jobId: "abc123", attempt: 2 });
    });

    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed["level"]).toBe("error");
    expect(parsed["message"]).toBe("job failed");
    expect(parsed["jobId"]).toBe("abc123");
    expect(parsed["attempt"]).toBe(2);
  });

  it("drops a credential passed under its registry name", () => {
    const line = captureLine(() => {
      log.error("verification failed", { WHATSAPP_ACCESS_TOKEN: TOKEN });
    });

    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[redacted]");
  });

  it("drops an authorization header inside a nested object", () => {
    const line = captureLine(() => {
      log.error("request failed", {
        request: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
    });

    expect(line).not.toContain(TOKEN);
  });

  it("scrubs a token echoed back inside a provider message", () => {
    /*
     * The case the whole file exists for. Nothing here is under a key that
     * names it — Meta quoted our own request back inside prose.
     */
    const line = captureLine(() => {
      log.error("meta rejected the request", {
        providerMessage: `Invalid OAuth access token: access_token=${TOKEN} is malformed`,
      });
    });

    expect(line).not.toContain(TOKEN);
  });

  it("scrubs a token out of an Error's message and stack", () => {
    const error = new Error(
      `fetch failed: https://graph.facebook.com/v21.0/me?access_token=${TOKEN}`,
    );

    const line = captureLine(() => {
      log.error("provider call threw", { error });
    });

    expect(line).not.toContain(TOKEN);
    /* And the error survived as something worth reading. */
    expect(line).toContain("fetch failed");
  });

  it("does not hang on a circular object", () => {
    const circular: Record<string, unknown> = { name: "socket" };
    circular["self"] = circular;

    const line = captureLine(() => {
      log.error("connection dropped", { circular });
    });

    expect(line).toContain("[circular]");
  });

  it("never prints key material handed to it as a Buffer", () => {
    const line = captureLine(() => {
      log.error("key loaded", { material: Buffer.alloc(32, 7) });
    });

    expect(line).not.toContain("BwcHBwcH");
    expect(line).toContain("[buffer 32 bytes]");
  });
});

describe("log.info", () => {
  it("redacts on every level, not only error", () => {
    /* emit() is shared, but a future refactor could easily make it not be. */
    const line = captureLine(() => {
      log.info("integration connected", { META_ADS_ACCESS_TOKEN: TOKEN });
    });

    expect(line).not.toContain(TOKEN);
  });
});
