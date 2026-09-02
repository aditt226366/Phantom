import { describe, expect, it, vi } from "vitest";

import { parseLeadScore, scoreConversation } from "../src/verse/score.ts";
import type { ModelRouter } from "../src/verse/router.ts";

/**
 * Lead scoring, and the two ways it must refuse to guess.
 *
 * NULL is not COLD. The schema comment on contacts.lead_score says so and this
 * is the code half: a report counting unscored contacts as cold would tell a
 * business its entire contact book was uninterested.
 */

function router(text: string, kind: "answered" | "refused" = "answered"): ModelRouter {
  return {
    tier: "V2",
    complete: async () =>
      kind === "answered"
        ? {
            kind: "answered",
            text,
            usage: { inputTokens: 20, outputTokens: 1 },
            latencyMs: 90,
          }
        : { kind: "refused", reason: "no", latencyMs: 5 },
  };
}

describe("parseLeadScore", () => {
  it.each([
    ["HOT", "HOT"],
    ["hot", "HOT"],
    ["  Warm ", "WARM"],
    ["COLD.", "COLD"],
  ])("reads %j as %s", (input, expected) => {
    expect(parseLeadScore(input)).toBe(expected);
  });

  it("refuses a sentence that merely contains the word", () => {
    /*
     * `includes` would read this as HOT, and it means the opposite. A cheap
     * classifier's failure must not become a fact written against a contact
     * that nothing downstream ever revisits.
     */
    expect(parseLeadScore("I would not say this is HOT")).toBeNull();
  });

  it.each(["", "maybe", "HOT or WARM", "3"])("refuses %j", (input) => {
    expect(parseLeadScore(input)).toBeNull();
  });
});

describe("scoreConversation", () => {
  it("scores from the customer's words", async () => {
    expect(await scoreConversation(router("HOT"), [
      { role: "customer", text: "do you have the blue one in stock, I want it today" },
    ])).toBe("HOT");
  });

  it("sends only the customer's turns", async () => {
    /*
     * What the business said is not evidence about how interested the customer
     * is, and including it doubles the prompt for every message of every
     * campaign - the cost that matters most in this phase.
     */
    const complete = vi.fn(async (_request: unknown) => ({
      kind: "answered" as const,
      text: "WARM",
      usage: { inputTokens: 5, outputTokens: 1 },
      latencyMs: 10,
    }));

    await scoreConversation({ tier: "V2", complete }, [
      { role: "customer", text: "hi" },
      { role: "assistant", text: "hello, how can I help" },
      { role: "customer", text: "just looking" },
    ]);

    const request = complete.mock.calls[0]![0] as { turns: Array<{ role: string }> };
    expect(request.turns.every((turn) => turn.role === "customer")).toBe(true);
    expect(request.turns).toHaveLength(2);
  });

  it("returns null rather than COLD when the model declines", async () => {
    expect(await scoreConversation(router("", "refused"), [
      { role: "customer", text: "hello" },
    ])).toBeNull();
  });

  it("returns null when the customer has said nothing", async () => {
    expect(await scoreConversation(router("HOT"), [
      { role: "assistant", text: "hello" },
    ])).toBeNull();
  });

  it("caps the output, because this runs on every inbound message", async () => {
    const complete = vi.fn(async (_request: unknown) => ({
      kind: "answered" as const,
      text: "WARM",
      usage: { inputTokens: 5, outputTokens: 1 },
      latencyMs: 10,
    }));

    await scoreConversation({ tier: "V2", complete }, [
      { role: "customer", text: "hi" },
    ]);

    const request = complete.mock.calls[0]![0] as { maxOutputTokens: number };
    /* One word. The ceiling is a cost control as much as a format one: the
       classifier cannot run away into a paragraph nobody reads. */
    expect(request.maxOutputTokens).toBeLessThanOrEqual(16);
  });
});
