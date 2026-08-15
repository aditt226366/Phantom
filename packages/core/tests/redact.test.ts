import { describe, expect, it } from "vitest";
import { ALL_INTEGRATION_KEYS } from "../src/integrations.ts";
import {
  REDACTED,
  isSecretKey,
  redactKeys,
  scrubText,
  scrubValues,
} from "../src/redact.ts";

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxSuperSecretAccessToken";

describe("isSecretKey", () => {
  it("covers every key in the provider registry", () => {
    /*
     * The property that matters most, and the reason the registry is a single
     * declaration: a credential cannot be added to the form without the
     * redactor learning about it. Enumerated rather than sampled, so adding a
     * provider key that the redactor misses fails here.
     */
    for (const key of ALL_INTEGRATION_KEYS) {
      expect(isSecretKey(key), `${key} is not treated as a secret`).toBe(true);
    }
  });

  it("ignores case and separators", () => {
    for (const spelling of [
      "GOOGLE_PRIVATE_KEY",
      "googlePrivateKey",
      "google-private-key",
      "Google Private Key",
    ]) {
      expect(isSecretKey(spelling), spelling).toBe(true);
    }
  });

  it("catches an authorization header, which no provider declares", () => {
    /* Where a token most often appears in a fetch error, and a name that is in
       no registry anywhere. */
    for (const name of ["authorization", "Authorization", "set-cookie"]) {
      expect(isSecretKey(name), name).toBe(true);
    }
  });

  it("catches generic names as substrings", () => {
    for (const name of ["accessToken", "x-api-key", "refresh_token"]) {
      expect(isSecretKey(name), name).toBe(true);
    }
  });

  it("leaves ordinary names alone", () => {
    for (const name of ["companyId", "attempt", "statusCode", "provider"]) {
      expect(isSecretKey(name), name).toBe(false);
    }
  });
});

describe("scrubValues", () => {
  it("removes a known secret from the middle of a sentence", () => {
    const echoed = `Invalid OAuth access token: ${TOKEN} is malformed`;

    expect(scrubValues(echoed, [TOKEN])).not.toContain(TOKEN);
    expect(scrubValues(echoed, [TOKEN])).toContain(REDACTED);
  });

  it("removes every occurrence, not just the first", () => {
    const twice = `${TOKEN} and again ${TOKEN}`;

    expect(scrubValues(twice, [TOKEN])).not.toContain(TOKEN);
  });

  it("handles a secret containing regex metacharacters", () => {
    /* A private key is a PEM block; tokens contain + and /. Building a RegExp
       from a secret is how this goes wrong. */
    const awkward = "abc+def/ghi.jkl$mno[pqr]";
    const text = `failed with ${awkward} at the end`;

    expect(scrubValues(text, [awkward])).toBe(`failed with ${REDACTED} at the end`);
  });

  it("ignores an empty secret", () => {
    /*
     * "" matches at every position: splitting on it and rejoining would
     * replace the whole message with separators. Reachable, because an
     * unset optional credential is an empty string.
     */
    const text = "nothing secret here";

    expect(scrubValues(text, [""])).toBe(text);
  });

  it("ignores a secret shorter than eight characters", () => {
    /*
     * Not hypothetical: WHATSAPP_PHONE_NUMBER_ID is in the vault, gets passed
     * to the scrubber with everything else, and is neither long nor secret.
     * Scrubbing "123" would gut every timestamp and id in the line.
     */
    const text = "phone 123 failed at 2026-08-15T12:34:56 with attempt 3";

    expect(scrubValues(text, ["123"])).toBe(text);
    expect(scrubValues(text, ["3"])).toBe(text);
  });

  it("scrubs a value of exactly eight characters", () => {
    /* The boundary itself, so the comparison cannot quietly be off by one. */
    expect(scrubValues("x abcdefgh y", ["abcdefgh"])).toBe(`x ${REDACTED} y`);
  });

  it("tolerates undefined entries", () => {
    /* Vault rows come back as a record with optional values. */
    expect(scrubValues("plain", [undefined, TOKEN])).toBe("plain");
  });
});

describe("scrubText patterns", () => {
  it("scrubs an access_token query parameter", () => {
    const url = `https://graph.facebook.com/v21.0/me?access_token=${TOKEN}&fields=id`;
    const scrubbed = scrubText(url);

    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain("access_token=[redacted]");
    /* The rest of the URL is what makes the log worth keeping. */
    expect(scrubbed).toContain("graph.facebook.com");
    expect(scrubbed).toContain("fields=id");
  });

  it("scrubs a key query parameter", () => {
    expect(scrubText("https://sheets.googleapis.com/v4?key=AIzaSyABC123")).toBe(
      "https://sheets.googleapis.com/v4?key=[redacted]",
    );
  });

  it("scrubs a bearer token", () => {
    expect(scrubText(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("works with no known secrets at all", () => {
    /* The pattern half must stand alone: these fire for a credential that was
       never in our registry, because the provider generated it. */
    expect(scrubText(`?access_token=${TOKEN}`, [])).not.toContain(TOKEN);
  });
});

describe("redactKeys", () => {
  it("replaces a value under a secret name", () => {
    const out = redactKeys({ WHATSAPP_ACCESS_TOKEN: TOKEN, companyId: "c1" });

    expect(out).toEqual({ WHATSAPP_ACCESS_TOKEN: REDACTED, companyId: "c1" });
  });

  it("descends into nested objects and arrays", () => {
    const out = redactKeys({
      request: { headers: [{ authorization: `Bearer ${TOKEN}` }] },
    });

    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("keeps an Error readable while scrubbing it", () => {
    /*
     * Error's own properties are not enumerable, so a naive walk returns {}
     * and throws away the only useful part of the log line.
     */
    const error = new Error(`fetch failed: ?access_token=${TOKEN}`);
    const out = redactKeys({ error }) as { error: Record<string, unknown> };

    expect(out.error["name"]).toBe("Error");
    expect(out.error["message"]).toContain("fetch failed");
    expect(out.error["message"]).not.toContain(TOKEN);
    expect(String(out.error["stack"])).not.toContain(TOKEN);
  });

  it("walks an error's cause and attached properties", () => {
    const error = Object.assign(
      new Error("outer", { cause: new Error(`inner ?token=${TOKEN}`) }),
      { statusCode: 401, authorization: TOKEN },
    );

    const serialised = JSON.stringify(redactKeys(error));

    expect(serialised).not.toContain(TOKEN);
    expect(serialised).toContain("401");
  });

  it("does not hang on a cycle", () => {
    const circular: Record<string, unknown> = { name: "socket" };
    circular["self"] = circular;

    expect(JSON.stringify(redactKeys(circular))).toContain("[circular]");
  });

  it("handles a cycle through an array", () => {
    const list: unknown[] = [];
    list.push(list);

    expect(JSON.stringify(redactKeys({ list }))).toContain("[circular]");
  });

  it("reports a Buffer by length rather than by content", () => {
    /* Key material is a Buffer. Printing its bytes is the failure this file
       exists to prevent. */
    const out = redactKeys({ material: Buffer.alloc(32, 7) });

    expect(out).toEqual({ material: "[buffer 32 bytes]" });
  });

  it("survives the values a logger actually receives", () => {
    const out = redactKeys({
      when: new Date("2026-08-15T00:00:00.000Z"),
      count: 3n,
      missing: undefined,
      empty: null,
      handler: () => undefined,
    }) as Record<string, unknown>;

    expect(out["when"]).toBe("2026-08-15T00:00:00.000Z");
    expect(out["count"]).toBe("3");
    expect(out["empty"]).toBeNull();
    expect(out["handler"]).toBe("[function]");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("scrubs known secret values wherever they sit", () => {
    /* Under an innocent key, which is exactly the echo case. */
    const out = redactKeys({ providerMessage: `rejected ${TOKEN}` }, [TOKEN]);

    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
