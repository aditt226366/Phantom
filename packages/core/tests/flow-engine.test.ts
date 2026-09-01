import { describe, expect, it } from "vitest";
import { MAX_STEPS_PER_ADVANCE, type FlowGraph, type FlowNode } from "../src/flows/nodes.ts";
import { planAdvance, planEntry, type FlowEffect } from "../src/flows/engine.ts";

/**
 * What one tap does.
 *
 * The engine is pure, which is what lets these be assertions about values
 * rather than about a fixture that has to be provoked. The step ceiling is a
 * number of iterations rather than a timeout. Version pinning is this function
 * being handed one graph rather than another. And determinism - the same input
 * always producing the same next node, which is the product - is a property of
 * a function with no clock, no queue and no network in it.
 */

const entry: FlowNode = {
  id: "start",
  kind: "entry",
  templateId: "tpl_1",
  variables: [],
  choices: [
    { key: "buy", label: "Buy", next: "menu" },
    { key: "help", label: "Help", next: "human" },
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
      { key: "shoes", label: "Shoes", next: "score" },
      { key: "bags", label: "Bags", next: "bye" },
    ],
  },
};

const score: FlowNode = {
  id: "score",
  kind: "action",
  actions: [{ kind: "set_score", score: "HOT" }, { kind: "add_tag", tag: "shoes" }],
  next: "size",
};

const size: FlowNode = {
  id: "size",
  kind: "collect",
  body: "What size?",
  variable: "size",
  next: "route",
};

const route: FlowNode = {
  id: "route",
  kind: "branch",
  variable: "size",
  cases: [{ equals: "11", next: "human" }],
  fallback: "bye",
};

const human: FlowNode = {
  id: "human",
  kind: "handoff",
  body: "Someone will be in touch.",
  note: "wants help",
};

const bye: FlowNode = { id: "bye", kind: "end", body: "Thanks!" };

const GRAPH: FlowGraph = {
  entryNodeId: "start",
  nodes: [entry, menu, score, size, route, human, bye],
};

function kinds(effects: FlowEffect[]): string[] {
  return effects.map((e) => `${e.kind}:${e.node.id}`);
}

describe("entering a flow", () => {
  it("walks from the entry choice to the first thing that waits", () => {
    const plan = planEntry(GRAPH, "start", "buy");

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    /* The question is sent, and then the run stops. */
    expect(kinds(plan.effects)).toEqual(["send:menu", "wait:menu"]);
    expect(plan.position).toEqual({ kind: "waiting", nodeId: "menu" });
  });

  it("starts with no variables, because a run's answers are its own", () => {
    const plan = planEntry(GRAPH, "start", "buy");
    expect(plan.ok && plan.variables).toEqual({});
  });

  it("refuses a choice the entry node does not offer", () => {
    expect(planEntry(GRAPH, "start", "nonsense")).toEqual({
      ok: false,
      reason: "unknown_choice",
    });
  });
});

describe("advancing", () => {
  it("performs the actions on the way and stops at the next question", () => {
    const plan = planAdvance(GRAPH, "menu", { kind: "choice", key: "shoes" }, {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(kinds(plan.effects)).toEqual(["act:score", "send:size", "wait:size"]);
    /* The question's own variable remembers which button was tapped. */
    expect(plan.variables).toEqual({ want: "shoes" });
  });

  it("stores what the customer typed at a collect node", () => {
    const plan = planAdvance(GRAPH, "size", { kind: "text", value: "11" }, {
      want: "shoes",
    });

    expect(plan.ok && plan.variables).toEqual({ want: "shoes", size: "11" });
  });

  it("routes a branch on the stored value, first match wins", () => {
    const plan = planAdvance(GRAPH, "size", { kind: "text", value: "11" }, {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.position).toEqual({ kind: "ended", status: "HANDED_OFF" });
  });

  it("takes the fallback when nothing matches", () => {
    const plan = planAdvance(GRAPH, "size", { kind: "text", value: "9" }, {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.position).toEqual({ kind: "ended", status: "COMPLETED" });
  });

  it("takes the fallback for a variable that was never set, not the empty case", () => {
    /*
     * A customer who never reached the question that sets `size` has not
     * answered it with "". Reading a missing answer as an empty one routes
     * them down the branch written for people who answered it with nothing,
     * which is a different group of people.
     */
    const emptyCase: FlowNode = {
      id: "route",
      kind: "branch",
      variable: "size",
      cases: [{ equals: "", next: "human" }],
      fallback: "bye",
    };

    const graph: FlowGraph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === "route" ? emptyCase : n)),
    };

    const plan = planAdvance(graph, "route", { kind: "choice", key: "x" }, {});
    /* A branch does not take an answer at all. */
    expect(plan).toEqual({ ok: false, reason: "not_waiting" });

    /* Reached properly, through the collect node above it, with nothing set. */
    const noVariable: FlowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "menu"
          ? {
              ...menu,
              variable: null,
              presentation: {
                as: "buttons" as const,
                choices: [{ key: "shoes", label: "Shoes", next: "route" }],
              },
            }
          : n,
      ),
    };

    const walked = planAdvance(noVariable, "menu", { kind: "choice", key: "shoes" }, {});
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    /* bye, the fallback - not human, the empty-string case. */
    expect(kinds(walked.effects)).toEqual(["send:bye", "finish:bye"]);
  });
});

describe("what the engine refuses", () => {
  it("refuses a node this version does not contain", () => {
    /*
     * The version-pinning failure, seen from inside. A run pinned to version 2
     * taps a node that only version 3 has: the graph handed here is version 2's,
     * so the node is simply not in it.
     */
    expect(planAdvance(GRAPH, "deleted_node", { kind: "choice", key: "x" }, {})).toEqual({
      ok: false,
      reason: "unknown_node",
    });
  });

  it("refuses a typed reply to a question with buttons", () => {
    /*
     * The customer wrote "yes" instead of tapping Yes. That reads as agreement
     * to a person and is not one to a tree - there is no choice key for it, and
     * matching the label to guess which button they meant is the kind of
     * cleverness that puts somebody in the wrong branch. The executor turns
     * this into a handoff so a person sees the thread.
     */
    expect(planAdvance(GRAPH, "menu", { kind: "text", value: "shoes" }, {})).toEqual({
      ok: false,
      reason: "not_waiting",
    });
  });

  it("refuses an answer at a node that is not waiting for one", () => {
    expect(planAdvance(GRAPH, "score", { kind: "choice", key: "x" }, {})).toEqual({
      ok: false,
      reason: "not_waiting",
    });
  });
});

describe("the ceiling", () => {
  it("stops a loop with nothing waiting in it, rather than walking for ever", () => {
    /*
     * validateFlow refuses this shape at publish, so reaching the ceiling means
     * the graph is pathological in a way that check did not anticipate - which
     * is what a guard of last resort is for.
     *
     * Counted rather than timed, deliberately: a runaway loop here is fast, and
     * a timeout would let it send fifty messages before noticing.
     */
    const a: FlowNode = { id: "a", kind: "message", body: "One", mediaId: null, next: "b" };
    const b: FlowNode = { id: "b", kind: "message", body: "Two", mediaId: null, next: "a" };
    const into: FlowNode = { ...entry, choices: [{ key: "go", label: "Go", next: "a" }] };

    const plan = planEntry({ entryNodeId: "start", nodes: [into, a, b] }, "start", "go");

    expect(plan).toEqual({ ok: false, reason: "step_ceiling" });
  });

  it("refuses a chain one node longer than the ceiling", () => {
    /*
     * The assertion that makes the ceiling a NUMBER rather than merely a stop.
     *
     * The loop above is refused by any finite ceiling, so on its own it proves
     * only that the walk terminates - a break-once that multiplied the limit a
     * millionfold left it green. What it costs to be wrong is not an infinite
     * loop, it is an effects array with a million entries in it before anything
     * gives up. This one and the chain below bracket the real value.
     */
    const chain: FlowNode[] = [];
    for (let i = 0; i <= MAX_STEPS_PER_ADVANCE; i++) {
      chain.push({
        id: `n${i}`,
        kind: "message",
        body: `Step ${i}`,
        mediaId: null,
        next: `n${i + 1}`,
      });
    }
    chain.push({ id: `n${MAX_STEPS_PER_ADVANCE + 1}`, kind: "end", body: null });

    const into: FlowNode = { ...entry, choices: [{ key: "go", label: "Go", next: "n0" }] };
    const plan = planEntry({ entryNodeId: "start", nodes: [into, ...chain] }, "start", "go");

    expect(plan).toEqual({ ok: false, reason: "step_ceiling" });
  });

  it("allows a legitimate chain right up to the ceiling", () => {
    /*
     * The other side of the same number, so that lowering it into the range of
     * a real flow is a failing test rather than a truncated conversation.
     * A chain of exactly MAX_STEPS_PER_ADVANCE nodes has to complete.
     */
    const chain: FlowNode[] = [];
    for (let i = 0; i < MAX_STEPS_PER_ADVANCE - 1; i++) {
      chain.push({
        id: `n${i}`,
        kind: "message",
        body: `Step ${i}`,
        mediaId: null,
        next: `n${i + 1}`,
      });
    }
    chain.push({ id: `n${MAX_STEPS_PER_ADVANCE - 1}`, kind: "end", body: null });

    const into: FlowNode = { ...entry, choices: [{ key: "go", label: "Go", next: "n0" }] };
    const plan = planEntry({ entryNodeId: "start", nodes: [into, ...chain] }, "start", "go");

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.position).toEqual({ kind: "ended", status: "COMPLETED" });
  });
});

describe("endings", () => {
  it("sends a handoff's message before it hands off", () => {
    const plan = planEntry(GRAPH, "start", "help");

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.effects)).toEqual(["send:human", "finish:human"]);
    expect(plan.position).toEqual({ kind: "ended", status: "HANDED_OFF" });
  });

  it("keeps a handoff apart from a completion", () => {
    /*
     * Both are endings and one of them is the flow saying it could not finish
     * the job. A report that called them the same thing would hide the question
     * every tenant asks first, which is how often the automation gives up.
     */
    const completed = planAdvance(GRAPH, "menu", { kind: "choice", key: "bags" }, {});
    expect(completed.ok && completed.position).toEqual({
      kind: "ended",
      status: "COMPLETED",
    });
  });

  it("ends rather than re-sending an approved template when a branch loops home", () => {
    /*
     * The entry sends a template, which costs money and opens a conversation
     * with somebody we are already talking to for free. Ending is the honest
     * outcome: the customer is back where they started, and a new run begins if
     * they tap the entry again.
     */
    const home: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [{ key: "back", label: "Start over", next: "start" }],
      },
    };

    const graph: FlowGraph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === "menu" ? home : n)),
    };

    const plan = planAdvance(graph, "menu", { kind: "choice", key: "back" }, {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.effects)).toEqual(["finish:start"]);
  });

  it("ends on an edge the author left pointing nowhere", () => {
    const stops: FlowNode = {
      ...menu,
      presentation: {
        as: "buttons",
        choices: [{ key: "shoes", label: "Shoes", next: null }],
      },
    };

    const graph: FlowGraph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === "menu" ? stops : n)),
    };

    const plan = planAdvance(graph, "menu", { kind: "choice", key: "shoes" }, {});

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.effects).toEqual([]);
    expect(plan.position).toEqual({ kind: "ended", status: "COMPLETED" });
  });
});

describe("the property the product is", () => {
  it("gives the same answer every time, for the same graph and the same input", () => {
    /*
     * No model, no clock, no randomness. A flow that cannot surprise its author
     * is the thing being sold, and it is also what makes this answerable to
     * Meta's ban on general-purpose chatbots without an argument.
     */
    const runs = Array.from({ length: 25 }, () =>
      JSON.stringify(planAdvance(GRAPH, "menu", { kind: "choice", key: "shoes" }, {})),
    );

    expect(new Set(runs).size).toBe(1);
  });

  it("does not mutate the variables it was given", () => {
    const before = { want: "bags" };
    planAdvance(GRAPH, "menu", { kind: "choice", key: "shoes" }, before);
    expect(before).toEqual({ want: "bags" });
  });
});
