import { inspect } from "node:util";
import { redactKeys } from "@whatsapp-os/core";
import { describe, expect, it } from "vitest";
import { RedactedSecret } from "@/lib/webhook-secrets.ts";

/**
 * The cached secret must not print, by any route.
 *
 * The integration registry already scrubs by key NAME - a secret sitting under
 * WHATSAPP_APP_SECRET in a logged object is replaced by redactKeys before it
 * reaches a log. This is the other direction: the value escaping somewhere the
 * redactor never looks, which is every place a string gets interpolated,
 * serialised or inspected.
 *
 * Asserted against the real plaintext rather than against the shape of the
 * output, so a test cannot pass by matching a "[redacted]" that appears
 * somewhere else in the same line.
 */

const PLAINTEXT = "a1b2c3-super-secret-app-secret";

describe("a cached secret", () => {
  it("hands the plaintext back only to reveal()", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    expect(secret.reveal()).toBe(PLAINTEXT);
  });

  it("does not appear in a template literal", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    /* The commonest accident: a message built with the value in it. */
    expect(`signature check failed for ${secret}`).not.toContain(PLAINTEXT);
    expect(String(secret)).toBe("[redacted]");
  });

  it("does not appear in JSON", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    /* Structured logs serialise the whole context object. */
    const line = JSON.stringify({ webhook: { appSecret: secret } });

    expect(line).not.toContain(PLAINTEXT);
    expect(line).toContain("[redacted]");
  });

  it("does not appear in console.log's own formatting", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    expect(inspect(secret)).not.toContain(PLAINTEXT);
    expect(inspect({ appSecret: secret })).not.toContain(PLAINTEXT);
    expect(inspect(secret, { depth: 5, showHidden: true })).not.toContain(PLAINTEXT);

    /*
     * Exactly "[redacted]", not merely "no plaintext". A `#private` field is
     * already invisible to util.inspect, so the weaker assertion passes with
     * the custom hook deleted - which break-once demonstrated, and which made
     * the assertion prove nothing about the line it was written for.
     *
     * What the hook actually buys is that the output SAYS it withheld
     * something, instead of printing `RedactedSecret {}` and leaving a reader
     * to assume the object was empty.
     */
    expect(inspect(secret)).toBe("[redacted]");
    expect(inspect({ appSecret: secret })).toContain("[redacted]");
  });

  it("survives the redactor it is not covered by", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    /*
     * redactKeys scrubs by key name. Under a name it does not recognise the
     * value passes through untouched - which is exactly the gap this type
     * exists to close, so the assertion is that the wrapper holds even when the
     * redactor does nothing.
     */
    const scrubbed = redactKeys({ somethingUnrecognised: secret });

    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  it("does not leak through an Error built from it", () => {
    const secret = new RedactedSecret(PLAINTEXT);

    const error = new Error(`could not verify with ${secret}`);

    expect(error.message).not.toContain(PLAINTEXT);
    expect(inspect(error)).not.toContain(PLAINTEXT);
  });
});
