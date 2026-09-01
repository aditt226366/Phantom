import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_LIMITS,
  MAX_STEPS_PER_ADVANCE,
  choicesOf,
  edgesOf,
  validateFlow,
  type FlowGraph,
  type FlowNode,
} from "../src/flows/nodes.ts";
import { buildInteractivePayload, describeInteractive } from "../src/flows/interactive.ts";

/**
 * What a tree has to satisfy before a customer can be put into it.
 *
 * The interesting assertions are the ones about faults that produce a flow
 * which WORKS - for the author testing it, on the happy path - and fails for
 * some customer later. A fourth reply button is refused by Meta at send time,
 * in a thread, with nobody watching. An unreachable node is a branch the
 * author drew and no customer can arrive at. A loop with no tap in it sends
 * its way round for ever.
 */

const entry: FlowNode = {
  id: "start",
  kind: "entry",
  templateId: "tpl_1",
  variables: [],
  choices: [
    { key: "buy", label: "Buy something", next: "menu" },
    { key: "help", label: "Get help", next: "handoff" },
  ],
};

const menu: FlowNode = {
  id: "menu",
  kind: "question",
  body: "What are you after?",
  variable: "want",
  presentation: {
    as: "buttons",
    choices: [
      { key: "shoes", label: "Shoes", next: "done" },
      { key: "bags", label: "Bags", next: "done" },
    ],
  },
};

const handoff: FlowNode = { id: "handoff", kind: "handoff", body: null, note: null };
const done: FlowNode = { id: "done", kind: "end", body: "Thanks!" };

function graph(nodes: FlowNode[], entryNodeId = "start"): FlowGraph {
  return { entryNodeId, nodes };
}

function codes(input: unknown): string[] {
  return validateFlow(input).issues.map((i) => i.code).sort();
}

describe("a flow that is fine", () => {
  it("passes", () => {
    const result = validateFlow(graph([entry, menu, handoff, done]));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("the entry point, which is the whole window constraint", () => {
  it("refuses a flow with no entry node", () => {
    /*
     * Interactive messages only work inside the 24-hour window, so a flow that
     * starts with one works for every customer who wrote in today and silently
     * fails for everybody else - the worst possible way to find out, because
     * the author's own test always passes.
     */
    expect(codes(graph([menu, done], "menu"))).toContain("entry_missing");
  });

  it("refuses a flow that starts anywhere but the entry node", () => {
    expect(codes(graph([entry, menu, handoff, done], "menu"))).toContain(
      "entry_not_entry_node",
    );
  });

  it("refuses two entry nodes", () => {
    const second: FlowNode = { ...entry, id: "start2" };
    expect(codes(graph([entry, second, menu, handoff, done]))).toContain(
      "entry_duplicated",
    );
  });
});

describe("Meta's limits", () => {
  it("refuses a fourth reply button", () => {
    const four: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [
          { key: "a", label: "A", next: "done" },
          { key: "b", label: "B", next: "done" },
          { key: "c", label: "C", next: "done" },
          { key: "d", label: "D", next: "done" },
        ],
      },
    };

    expect(codes(graph([entry, four, handoff, done]))).toContain("unparseable");
  });

  it("refuses a button label over twenty characters", () => {
    const long: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [{ key: "a", label: "x".repeat(21), next: "done" }],
      },
    };

    expect(codes(graph([entry, long, handoff, done]))).toContain("unparseable");
  });

  it("counts list rows across every section, not per section", () => {
    /*
     * The limit people get wrong. Six sections of two rows each is inside every
     * per-section limit and over Meta's total of ten - and a schema that only
     * bounded each section would accept it.
     */
    const sections = Array.from({ length: 6 }, (_, i) => ({
      title: `Section ${i}`,
      choices: [
        { key: `a${i}`, label: `A${i}`, next: "done" },
        { key: `b${i}`, label: `B${i}`, next: "done" },
      ],
    }));

    const list: FlowNode = {
      ...menu,
      presentation: { as: "list", button: "Choose", sections },
    };

    const result = validateFlow(graph([entry, list, handoff, done]));
    expect(result.issues.map((i) => i.code)).toContain("list_rows_over_limit");
    expect(result.issues.find((i) => i.code === "list_rows_over_limit")?.message).toContain(
      "12 list rows",
    );
  });
});

describe("the structure", () => {
  it("refuses an edge pointing nowhere", () => {
    const broken: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [{ key: "shoes", label: "Shoes", next: "nowhere" }],
      },
    };

    expect(codes(graph([entry, broken, handoff, done]))).toContain("dangling_edge");
  });

  it("suppresses reachability findings while an edge is broken", () => {
    /*
     * One dangling edge orphans everything behind it, so reporting both
     * produces a page of findings that all disappear when one typo is fixed -
     * which teaches an author to stop reading the list.
     */
    const broken: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [{ key: "shoes", label: "Shoes", next: "nowhere" }],
      },
    };

    expect(codes(graph([entry, broken, handoff, done]))).not.toContain(
      "unreachable_node",
    );
  });

  it("refuses a node nothing leads to", () => {
    const orphan: FlowNode = { id: "orphan", kind: "end", body: null };
    expect(codes(graph([entry, menu, handoff, done, orphan]))).toContain(
      "unreachable_node",
    );
  });

  it("refuses two nodes with the same id", () => {
    expect(codes(graph([entry, menu, { ...done, id: "menu" }, handoff]))).toContain(
      "duplicate_node_id",
    );
  });

  it("refuses two choices on one node with the same key", () => {
    /* A tap carries the key, so the two answers are indistinguishable when it
       comes back - and the run would take whichever branch was listed first. */
    const clashing: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [
          { key: "same", label: "Shoes", next: "done" },
          { key: "same", label: "Bags", next: "handoff" },
        ],
      },
    };

    expect(codes(graph([entry, clashing, handoff, done]))).toContain(
      "duplicate_choice_key",
    );
  });
});

describe("cycles", () => {
  it("allows a loop back to a menu, because that is an ordinary thing to draw", () => {
    const back: FlowNode = {
      id: "sorry",
      kind: "message",
      body: "Let us try again.",
      mediaId: null,
      next: "menu",
    };

    const withLoop: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [
          { key: "shoes", label: "Shoes", next: "done" },
          { key: "again", label: "Start over", next: "sorry" },
        ],
      },
    };

    expect(validateFlow(graph([entry, withLoop, back, handoff, done])).ok).toBe(true);
  });

  it("refuses a loop with nothing waiting for the customer in it", () => {
    /*
     * message -> action -> message, back to the first. The engine would walk it
     * until the ceiling stopped it, sending as it went - so the run is stopped,
     * but the customer already has the messages. Caught at publish, where the
     * cost is a sentence.
     */
    const a: FlowNode = { id: "a", kind: "message", body: "One", mediaId: null, next: "b" };
    const b: FlowNode = {
      id: "b",
      kind: "action",
      actions: [{ kind: "set_score", score: "WARM" }],
      next: "a",
    };

    const into: FlowNode = {
      ...entry,
      choices: [{ key: "go", label: "Go", next: "a" }],
    };

    const result = validateFlow(graph([into, a, b]));
    expect(result.issues.map((i) => i.code)).toContain("loop_without_input");
    expect(result.issues.find((i) => i.code === "loop_without_input")?.message).toMatch(
      /a -> b -> a|b -> a -> b/,
    );
  });

  it("has a ceiling well above any tree a person would draw", () => {
    /* The guard of last resort, for a graph shape validateFlow did not
       anticipate. Asserted so that lowering it into the range of a real flow
       is a failing test rather than a truncated conversation. */
    expect(MAX_STEPS_PER_ADVANCE).toBeGreaterThan(20);
  });
});

describe("endings", () => {
  it("refuses a flow no path leaves", () => {
    const a: FlowNode = {
      id: "a",
      kind: "question",
      body: "Again?",
      variable: null,
      presentation: { as: "buttons", choices: [{ key: "y", label: "Yes", next: "a" }] },
    };

    const into: FlowNode = { ...entry, choices: [{ key: "go", label: "Go", next: "a" }] };

    expect(codes(graph([into, a]))).toContain("no_ending");
  });
});

describe("the payload a question becomes", () => {
  it("puts the run and the node in every button id", () => {
    const payload = buildInteractivePayload(menu as never, "run77");
    const buttons = payload.action["buttons"] as Array<{ reply: { id: string; title: string } }>;

    expect(payload.type).toBe("button");
    expect(buttons.map((b) => b.reply.id)).toEqual([
      "f1.r.run77.menu.shoes",
      "f1.r.run77.menu.bags",
    ]);
    expect(buttons.map((b) => b.reply.title)).toEqual(["Shoes", "Bags"]);
  });

  it("puts the run and the node in every list row id too", () => {
    const list = {
      ...menu,
      presentation: {
        as: "list" as const,
        button: "Choose",
        sections: [
          {
            title: "Footwear",
            choices: [{ key: "shoes", label: "Shoes", description: "All sizes", next: "done" }],
          },
        ],
      },
    };

    const payload = buildInteractivePayload(list as never, "run77");
    const sections = payload.action["sections"] as Array<{
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;

    expect(payload.type).toBe("list");
    expect(sections[0]!.rows[0]!.id).toBe("f1.r.run77.menu.shoes");
    expect(sections[0]!.rows[0]!.description).toBe("All sizes");
  });

  it("throws rather than trimming a node Meta would refuse", () => {
    /*
     * Trimming is the tempting behaviour and the wrong one: a fourth answer
     * silently dropped is a customer who cannot give the answer they wanted,
     * and nothing anywhere would say so.
     */
    const four = {
      ...menu,
      presentation: {
        as: "buttons" as const,
        choices: Array.from({ length: 4 }, (_, i) => ({
          key: `k${i}`,
          label: `L${i}`,
          next: "done",
        })),
      },
    };

    expect(() => buildInteractivePayload(four as never, "run77")).toThrow(
      new RegExp(String(INTERACTIVE_LIMITS.MAX_BUTTONS)),
    );
  });

  it("describes a question by its body and its options, never its ids", () => {
    /* The thread is read by a person. The ids are correct, unique per run and
       completely unreadable. */
    const described = describeInteractive(menu);
    expect(described).toContain("What are you after?");
    expect(described).toContain("- Shoes");
    expect(described).not.toContain("f1.r.");
  });
});

describe("the graph helpers the engine and the builder share", () => {
  it("reads every edge off each node kind", () => {
    expect(edgesOf(entry).sort()).toEqual(["handoff", "menu"]);
    expect(edgesOf(menu).sort()).toEqual(["done", "done"]);
    expect(edgesOf(done)).toEqual([]);
    expect(edgesOf(handoff)).toEqual([]);
  });

  it("flattens a list's sections into one set of choices", () => {
    const list: FlowNode = {
      ...menu,
      presentation: {
        as: "list",
        button: "Choose",
        sections: [
          { title: "One", choices: [{ key: "a", label: "A", next: "done" }] },
          { title: "Two", choices: [{ key: "b", label: "B", next: "done" }] },
        ],
      },
    };

    expect(choicesOf(list).map((c) => c.key)).toEqual(["a", "b"]);
  });
});
