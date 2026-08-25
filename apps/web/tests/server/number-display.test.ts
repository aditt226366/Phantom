import { describe, expect, it } from "vitest";
import {
  qualityVariant,
  statusVariant,
  webhookUrl,
} from "../../lib/number-display.ts";

/**
 * The three decisions the numbers page makes about values Meta owns.
 *
 * Asserted as values rather than as markup. The page renders `status` verbatim,
 * so a test that searched the output for "FLAGGED" would pass whatever colour
 * the badge was — and the colour is the whole decision. Same reason the
 * reactivate control's test was rewritten: a word can survive in a neighbouring
 * heading long after the thing it described was deleted.
 */

describe("statusVariant", () => {
  it("marks only CONNECTED as good", () => {
    expect(statusVariant("CONNECTED")).toBe("success");
  });

  it.each(["FLAGGED", "RESTRICTED", "BANNED"])(
    "marks %s as an error",
    (status) => {
      expect(statusVariant(status)).toBe("error");
    },
  );

  /*
   * The half that matters, and the reason `status` is text and not an enum.
   *
   * Meta extends this vocabulary without notice. A value we have never seen
   * must read as neutral and render as itself — red would be claiming a verdict
   * nobody gave us, and green would be worse. UNKNOWN is in here on purpose:
   * it means "Meta has told us nothing", which is not the same as bad.
   */
  it.each(["UNKNOWN", "UNVERIFIED", "MIGRATED", "RATE_LIMITED", "SOMETHING_NEW"])(
    "leaves %s neutral rather than guessing",
    (status) => {
      expect(statusVariant(status)).toBe("default");
    },
  );
});

describe("qualityVariant", () => {
  it("reads the traffic light", () => {
    expect(qualityVariant("GREEN")).toBe("success");
    expect(qualityVariant("RED")).toBe("error");
  });

  /* No warning token exists in globals.css, and inventing one at the call site
     would be a literal outside that file. YELLOW carries itself. */
  it.each(["YELLOW", "UNKNOWN"])("leaves %s neutral", (rating) => {
    expect(qualityVariant(rating)).toBe("default");
  });
});

describe("webhookUrl", () => {
  it("builds the path Meta posts to", () => {
    expect(webhookUrl("https://app.example.com", "abc123")).toBe(
      "https://app.example.com/api/webhooks/whatsapp/abc123",
    );
  });

  /* APP_URL is validated as a URL and a trailing slash is a valid one. Doubling
     the slash produces a path Next does not route, so the webhook would simply
     never arrive — a long way to travel from one character. */
  it("does not double the slash", () => {
    expect(webhookUrl("https://app.example.com/", "abc123")).toBe(
      "https://app.example.com/api/webhooks/whatsapp/abc123",
    );
    expect(webhookUrl("https://app.example.com///", "abc123")).toBe(
      "https://app.example.com/api/webhooks/whatsapp/abc123",
    );
  });
});
