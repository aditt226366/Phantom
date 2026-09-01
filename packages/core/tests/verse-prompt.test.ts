import { describe, expect, it } from "vitest";

import {
  A5_HONESTY_RULE,
  A5_OFF_TOPIC_RULE,
  MAX_TURNS_WITHOUT_PROGRESS,
  buildSystemPrompt,
  escalationBefore,
  handoffMessage,
  handoffReason,
  isRestrictedSubject,
  turnsFrom,
  type EscalationReason,
} from "../src/verse/prompt.ts";
import type { RetrievedChunk } from "../src/verse/retrieval.ts";

/**
 * The prompt, the two compliance sentences, and when a person is needed.
 *
 * The A5 assertions are the reason this file exists. They are not style
 * checks: since 15 January 2026 a general-purpose LLM chatbot is banned on the
 * WhatsApp Business Platform, and the two behaviours below are what keep Verse
 * on the right side of that line. The realistic way it breaks is a prompt edit
 * six months from now making the assistant "more helpful" outside its task -
 * which is precisely the banned behaviour - so weakening either is a failing
 * test rather than a quiet change to a string.
 */

function chunk(content: string, title = "Delivery"): RetrievedChunk {
  return {
    chunkId: "c1",
    documentId: "d1",
    documentTitle: title,
    seq: 0,
    content,
    similarity: 0.8,
  };
}

const INPUT = {
  goal: "Answer questions about delivery and book collections.",
  businessName: "Kamat Textiles",
  chunks: [chunk("We deliver across Maharashtra in 3-5 working days.")],
};

describe("A5, which is compliance and not manners", () => {
  it("tells the model to refuse off-topic questions rather than disclaim them", () => {
    const prompt = buildSystemPrompt(INPUT);

    expect(prompt).toContain(A5_OFF_TOPIC_RULE);
    /*
     * The distinction the ban turns on, asserted in the text: answering with a
     * disclaimer attached is what a general-purpose chatbot does. Refusing is
     * what a task-specific business assistant does.
     */
    expect(A5_OFF_TOPIC_RULE).toContain("refuse it");
    expect(A5_OFF_TOPIC_RULE).toContain("do not answer");
  });

  it("tells the model to admit it is not a person", () => {
    const prompt = buildSystemPrompt(INPUT);

    expect(prompt).toContain(A5_HONESTY_RULE);
    expect(A5_HONESTY_RULE).toContain("not a person");
    expect(A5_HONESTY_RULE).toContain("Never claim or imply otherwise");
  });
});

describe("buildSystemPrompt", () => {
  it("carries the tenant's goal verbatim", () => {
    /*
     * The one part of the prompt the tenant authored. Normalising it - even to
     * fix spelling - changes what the model was asked to do, invisibly from
     * the UI.
     */
    const prompt = buildSystemPrompt({ ...INPUT, goal: "  sell   MORE saris  " });
    expect(prompt).toContain("  sell   MORE saris  ");
  });

  it("names the business, so the assistant knows who it speaks for", () => {
    expect(buildSystemPrompt(INPUT)).toContain("Kamat Textiles");
  });

  it("includes every passage, attributed to its document", () => {
    const prompt = buildSystemPrompt({
      ...INPUT,
      chunks: [chunk("Free over Rs 2000.", "Shipping"), chunk("Closed Sundays.", "Hours")],
    });

    expect(prompt).toContain("Free over Rs 2000.");
    expect(prompt).toContain("Closed Sundays.");
    /* Attribution, so an operator reading the thread can find the source. */
    expect(prompt).toContain("Shipping");
    expect(prompt).toContain("Hours");
  });

  it("forbids stating a price, date or policy that is not in the passages", () => {
    const prompt = buildSystemPrompt(INPUT);
    expect(prompt).toMatch(/never state a price/i);
  });

  it("contains no customer text", () => {
    /*
     * The customer's words live in the turns, never in the instruction block.
     * That does not stop injection by itself - the model still reads the turn -
     * but it removes the version that needs no cleverness, where a message
     * ends the instructions and starts new ones.
     */
    const prompt = buildSystemPrompt(INPUT);
    expect(prompt).not.toContain("customer said");
  });
});

describe("restricted subjects", () => {
  it.each([
    "I want a refund please",
    "how do I get refunded",
    "I would like to make a complaint",
    "my lawyer will be in touch",
    "is this safe with my medication",
    "I am allergic to nickel, is this safe",
    "I'll take you to consumer forum",
  ])("catches %j", (message) => {
    expect(isRestrictedSubject(message)).toBe(true);
  });

  it.each([
    "when will my order arrive",
    "do you deliver to Pune",
    "what are your opening hours",
    "is the blue one in stock",
  ])("lets an ordinary question through: %j", (message) => {
    expect(isRestrictedSubject(message)).toBe(false);
  });

  it("errs toward handing over rather than answering", () => {
    /*
     * The asymmetry, stated as a test. A false positive hands a conversation
     * to a person who did not need to see it. A false negative lets an
     * automated system discuss somebody's refund or their medication. This is
     * deliberately crude in the safe direction.
     */
    expect(isRestrictedSubject("refunds of any kind")).toBe(true);
    expect(isRestrictedSubject("REFUND")).toBe(true);
  });
});

describe("escalationBefore", () => {
  const base = { message: "do you deliver to Pune", grounded: true, turnsWithoutProgress: 0 };

  it("lets a grounded, ordinary question through", () => {
    expect(escalationBefore(base)).toBeNull();
  });

  it("escalates when nothing is grounded", () => {
    expect(escalationBefore({ ...base, grounded: false })).toBe("no_grounding");
  });

  it("escalates a restricted subject even when it IS grounded", () => {
    /*
     * The ordering that matters. A knowledge base that happens to contain the
     * refund policy would otherwise let the model answer a refund request,
     * which is the case the restriction exists for.
     */
    expect(
      escalationBefore({ ...base, message: "I want a refund", grounded: true }),
    ).toBe("restricted_subject");
  });

  /* --------------------------------------------------------------------- *
   * The turn ceiling, from both sides
   * --------------------------------------------------------------------- */

  it("does not escalate one turn below the ceiling", () => {
    expect(
      escalationBefore({
        ...base,
        turnsWithoutProgress: MAX_TURNS_WITHOUT_PROGRESS - 1,
      }),
    ).toBeNull();
  });

  it("escalates exactly at the ceiling", () => {
    expect(
      escalationBefore({
        ...base,
        turnsWithoutProgress: MAX_TURNS_WITHOUT_PROGRESS,
      }),
    ).toBe("no_progress");
  });
});

describe("what each side reads", () => {
  const reasons: EscalationReason[] = [
    "no_grounding",
    "restricted_subject",
    "no_progress",
    "model_refused",
  ];

  it.each(reasons)("gives the customer a plain sentence for %s", (reason) => {
    const message = handoffMessage(reason);

    expect(message.length).toBeGreaterThan(0);
    /*
     * The customer does not need to know a similarity floor was not cleared.
     * They need to know a person is coming.
     */
    expect(message).not.toMatch(/similarity|floor|knowledge base|model|prompt/i);
    expect(message).toMatch(/colleague/i);
  });

  it.each(reasons)("gives the operator the machinery for %s", (reason) => {
    /* The operator-facing sentence IS allowed to name it - it goes into
       needs_human_reason, where the whole point is knowing why. */
    expect(handoffReason(reason)).toMatch(/^Verse stopped: /);
  });
});

describe("turnsFrom", () => {
  it("maps inbound to customer and outbound to assistant, in order", () => {
    expect(
      turnsFrom([
        { inbound: true, body: "hi" },
        { inbound: false, body: "hello" },
        { inbound: true, body: "do you deliver" },
      ]),
    ).toEqual([
      { role: "customer", text: "hi" },
      { role: "assistant", text: "hello" },
      { role: "customer", text: "do you deliver" },
    ]);
  });

  it("drops messages with no text", () => {
    /*
     * A media message with no caption has a null body. Sending it as an empty
     * turn is a turn that says nothing, which some providers reject outright
     * and all of them are confused by.
     */
    expect(
      turnsFrom([
        { inbound: true, body: null },
        { inbound: true, body: "   " },
        { inbound: true, body: "real" },
      ]),
    ).toEqual([{ role: "customer", text: "real" }]);
  });
});
