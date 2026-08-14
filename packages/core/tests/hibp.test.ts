import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPasswordBreached } from "../src/hibp.ts";

/**
 * fetch is mocked throughout: a unit test must not depend on a third-party
 * service being reachable, and the fail-open path is precisely what has to be
 * exercised without waiting three real seconds for a timeout.
 */

const PASSWORD = "hunter2-but-longer";

function digestOf(value: string): { prefix: string; suffix: string } {
  const hex = createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

function mockFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("k-anonymity", () => {
  it("sends only the first five hash characters, never the password", async () => {
    const { prefix } = digestOf(PASSWORD);
    let requestedUrl = "";
    let headers: Record<string, string> = {};

    mockFetch(async (input, init) => {
      requestedUrl = String(input);
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response("ABCDE:1\n", { status: 200 });
    });

    await checkPasswordBreached(PASSWORD);

    expect(requestedUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(requestedUrl).not.toContain(PASSWORD);

    /* The whole point: five characters, not six, not the digest. */
    const sent = requestedUrl.split("/range/")[1]!;
    expect(sent).toHaveLength(5);

    expect(headers["Add-Padding"]).toBe("true");
    expect(headers["User-Agent"]).toBeTruthy();
  });
});

describe("when the range API answers", () => {
  it("reports a breached password", async () => {
    const { suffix } = digestOf(PASSWORD);

    mockFetch(
      async () =>
        new Response(`0000000000000000000000000000000000:5\n${suffix}:42\n`, {
          status: 200,
        }),
    );

    await expect(checkPasswordBreached(PASSWORD)).resolves.toEqual({
      checked: true,
      breached: true,
    });
  });

  it("reports a clean password", async () => {
    mockFetch(
      async () =>
        new Response("0000000000000000000000000000000000:5\n1111111111111111111111111111111111:9\n", {
          status: 200,
        }),
    );

    await expect(checkPasswordBreached(PASSWORD)).resolves.toEqual({
      checked: true,
      breached: false,
    });
  });

  it("ignores padding entries", async () => {
    /*
     * With Add-Padding, HIBP returns synthetic suffixes with a count of 0 so
     * every response is a similar size. Counting one as a hit would reject a
     * perfectly good password — and only for some passwords, which would be a
     * miserable bug to track down.
     */
    const { suffix } = digestOf(PASSWORD);

    mockFetch(
      async () =>
        new Response(`${suffix}:0\n2222222222222222222222222222222222:0\n`, {
          status: 200,
        }),
    );

    await expect(checkPasswordBreached(PASSWORD)).resolves.toEqual({
      checked: true,
      breached: false,
    });
  });

  it("matches case-insensitively", async () => {
    const { suffix } = digestOf(PASSWORD);

    mockFetch(async () => new Response(`${suffix.toLowerCase()}:3\n`, { status: 200 }));

    await expect(checkPasswordBreached(PASSWORD)).resolves.toEqual({
      checked: true,
      breached: true,
    });
  });
});

describe("when the range API does not answer", () => {
  it("fails open on timeout, and says so", async () => {
    /*
     * checked:false is a third outcome, not a synonym for "not breached". C7
     * writes an audit row from it, so the distinction has to survive.
     */
    mockFetch(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });

    const result = await checkPasswordBreached(PASSWORD);

    expect(result.checked).toBe(false);
    if (!result.checked) {
      expect(result.reason).toMatch(/timed out/i);
    }
  });

  it("fails open on a server error", async () => {
    mockFetch(async () => new Response("upstream is unwell", { status: 503 }));

    const result = await checkPasswordBreached(PASSWORD);

    expect(result.checked).toBe(false);
    if (!result.checked) {
      expect(result.reason).toContain("503");
    }
  });

  it("fails open on a network error", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await checkPasswordBreached(PASSWORD);

    expect(result.checked).toBe(false);
    if (!result.checked) {
      expect(result.reason).toMatch(/fetch failed/);
    }
  });

  it("never reports breached when it could not check", async () => {
    /*
     * Guards the shape itself: a caller doing `if (result.breached)` on an
     * unchecked result must not get a truthy value by accident.
     */
    mockFetch(async () => new Response("", { status: 500 }));

    const result = await checkPasswordBreached(PASSWORD);
    expect("breached" in result).toBe(false);
  });
});
