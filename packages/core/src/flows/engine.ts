import {
  MAX_STEPS_PER_ADVANCE,
  choicesOf,
  type FlowGraph,
  type FlowNode,
} from "./nodes.ts";

/**
 * What one tap does, decided with no I/O at all.
 *
 * ===========================================================================
 * Why the engine is pure, and what that buys
 * ===========================================================================
 *
 * Advancing a run is a walk over a tree: route on the answer, perform whatever
 * the nodes on the way say, stop when something needs the customer again. None
 * of that needs a database, and every part of it is a rule an author drew and
 * expects to be able to predict.
 *
 * Separating it means the two hard properties can be asserted directly rather
 * than through a fixture. The step ceiling is a number of iterations, not a
 * timeout somebody has to provoke. Version pinning is the caller handing this
 * function one graph rather than another. And the whole point of the product -
 * the same input always produces the same next node - is a property of a
 * function with no clock, no queue and no network in it.
 *
 * The executor turns these effects into messages, rows and jobs. It is the
 * half that can fail; this half only decides.
 *
 * ===========================================================================
 * What this deliberately does NOT decide
 * ===========================================================================
 *
 * Whether the window is open. That is checked in the send path immediately
 * before each Graph call, because it can close between the moment a step is
 * planned and the moment it goes out - and a plan that had already declared
 * itself sendable would be wrong exactly when it mattered.
 *
 * Whether the tap is stale. A run that has moved on, or one that has ended, is
 * a fact about stored state rather than about the tree, so the executor
 * establishes it before it gets here. What this function does is make that
 * check possible: the button id names the node it was sent from, so the
 * comparison is one string against one column.
 */

/** Something the executor has to do, in order. */
export type FlowEffect =
  /** Put this node's message in front of the customer. */
  | { kind: "send"; node: FlowNode }
  /** Write something down: a score, a tag, a note. */
  | { kind: "act"; node: Extract<FlowNode, { kind: "action" }> }
  /** Everything before this has been sent; now wait for the customer. */
  | { kind: "wait"; node: FlowNode }
  /** The run is over. */
  | { kind: "finish"; node: FlowNode; status: "COMPLETED" | "HANDED_OFF" };

export type AdvanceFailure =
  /** The tap named a node this version does not contain. */
  | "unknown_node"
  /** The tap named a choice that node does not offer. */
  | "unknown_choice"
  /** The node the run is standing on does not take an answer. */
  | "not_waiting"
  /**
   * The walk did not stop.
   *
   * validateFlow refuses a loop with no waiting node in it, so reaching this
   * means the graph is pathological in a way that check did not anticipate -
   * which is exactly what a guard of last resort is for. The run is FAILED
   * rather than paused: paused means "waiting for the customer", and nothing
   * here is waiting for anybody, so an operator seeing a paused run would wait
   * for a tap that is never coming.
   */
  | "step_ceiling";

export type AdvancePlan =
  | {
      ok: true;
      effects: FlowEffect[];
      /** The run's variables after this advance. A new object, never mutated. */
      variables: Record<string, string>;
      /** Where the run stands afterwards. */
      position:
        | { kind: "waiting"; nodeId: string }
        | { kind: "ended"; status: "COMPLETED" | "HANDED_OFF" };
    }
  | { ok: false; reason: AdvanceFailure };

/** What the customer did. */
export type FlowInput =
  /** Tapped a reply button or picked a list row. */
  | { kind: "choice"; key: string }
  /** Typed something, at a node that was collecting. */
  | { kind: "text"; value: string };

function indexNodes(graph: FlowGraph): Map<string, FlowNode> {
  const byId = new Map<string, FlowNode>();
  for (const node of graph.nodes) byId.set(node.id, node);
  return byId;
}

/**
 * Where the run goes, and what it remembers, given an answer at a node.
 *
 * Split out because it is the half a stale tap has already failed before it
 * gets here: by this point the executor has established that `fromNodeId` is
 * where the run actually is.
 */
function route(
  node: FlowNode,
  input: FlowInput,
  variables: Record<string, string>,
): { target: string | null; variables: Record<string, string> } | AdvanceFailure {
  if (node.kind === "collect") {
    if (input.kind !== "text") return "not_waiting";
    return {
      target: node.next,
      variables: { ...variables, [node.variable]: input.value },
    };
  }

  if (node.kind !== "entry" && node.kind !== "question") return "not_waiting";

  /*
   * A typed reply to a question with buttons is not an answer to it.
   *
   * The customer wrote "yes" instead of tapping Yes, which reads as agreement
   * to a person and is not one to a tree: there is no choice key for it, and
   * guessing which button they meant by matching the label is the kind of
   * cleverness that puts somebody in the wrong branch. The executor turns this
   * into a handoff, so a person sees the thread.
   */
  if (input.kind !== "choice") return "not_waiting";

  const choice = choicesOf(node).find((c) => c.key === input.key);
  if (!choice) return "unknown_choice";

  const remembered =
    node.kind === "question" && node.variable
      ? { ...variables, [node.variable]: choice.key }
      : variables;

  return { target: choice.next, variables: remembered };
}

/**
 * Walk the tree from wherever the answer leads, and stop at the first thing
 * that needs the customer.
 *
 * `fromNodeId` is where the run is standing, NOT where it is going. The
 * executor has already checked that against the button id, which is the whole
 * mechanism that makes a three-day-old tap recognisable rather than obeyed.
 */
export function planAdvance(
  graph: FlowGraph,
  fromNodeId: string,
  input: FlowInput,
  variables: Record<string, string>,
): AdvancePlan {
  const byId = indexNodes(graph);
  const from = byId.get(fromNodeId);

  if (!from) return { ok: false, reason: "unknown_node" };

  const routed = route(from, input, variables);
  if (typeof routed === "string") return { ok: false, reason: routed };

  return walk(byId, routed.target, routed.variables);
}

/**
 * Enter a flow at the node its entry template pointed at.
 *
 * The same walk, reached differently: a tap on an approved template's quick
 * reply carries the version and the entry node rather than a run, because the
 * run does not exist until somebody taps. Sending a broadcast of ten thousand
 * entry templates must not create ten thousand runs for people who will mostly
 * never answer.
 */
export function planEntry(
  graph: FlowGraph,
  entryNodeId: string,
  choiceKey: string,
): AdvancePlan {
  return planAdvance(graph, entryNodeId, { kind: "choice", key: choiceKey }, {});
}

function walk(
  byId: Map<string, FlowNode>,
  start: string | null,
  variables: Record<string, string>,
): AdvancePlan {
  const effects: FlowEffect[] = [];
  let cursor = start;
  let steps = 0;
  let vars = variables;

  while (cursor !== null) {
    /*
     * The ceiling, checked before each node rather than after.
     *
     * Counting the walk rather than timing it: a runaway loop here is fast,
     * not slow, and a timeout would let it send fifty messages before noticing.
     */
    if (++steps > MAX_STEPS_PER_ADVANCE) {
      return { ok: false, reason: "step_ceiling" };
    }

    const node = byId.get(cursor);
    if (!node) return { ok: false, reason: "unknown_node" };

    switch (node.kind) {
      case "message":
        effects.push({ kind: "send", node });
        cursor = node.next;
        break;

      case "action":
        effects.push({ kind: "act", node });
        cursor = node.next;
        break;

      case "branch": {
        /*
         * Equality against a stored string, in order, first match wins - and
         * an unset variable is an empty string rather than a match on "".
         * Reading a missing answer as an empty one would route a customer who
         * never got to that question down the branch written for people who
         * answered it with nothing.
         */
        const value = vars[node.variable];
        const matched =
          value === undefined
            ? undefined
            : node.cases.find((c) => c.equals === value);

        cursor = matched ? matched.next : node.fallback;
        break;
      }

      case "question":
      case "collect":
        /* The message goes out, and then the run stops. Two effects rather
           than one, because the executor writes a SENT step and a wait. */
        effects.push({ kind: "send", node });
        effects.push({ kind: "wait", node });
        return { ok: true, effects, variables: vars, position: { kind: "waiting", nodeId: node.id } };

      case "handoff":
        if (node.body) effects.push({ kind: "send", node });
        effects.push({ kind: "finish", node, status: "HANDED_OFF" });
        return { ok: true, effects, variables: vars, position: { kind: "ended", status: "HANDED_OFF" } };

      case "end":
        if (node.body) effects.push({ kind: "send", node });
        effects.push({ kind: "finish", node, status: "COMPLETED" });
        return { ok: true, effects, variables: vars, position: { kind: "ended", status: "COMPLETED" } };

      case "entry":
        /*
         * Arriving back at the entry means a branch pointed at it. The tree is
         * legal - validateFlow allows loops - but the entry sends an approved
         * template, and re-sending one mid-conversation would charge the tenant
         * for a template to somebody they are already talking to for free.
         *
         * Treated as an ending rather than an error: the customer is back where
         * they started and the run is done. A new run begins if they tap the
         * entry again.
         */
        effects.push({ kind: "finish", node, status: "COMPLETED" });
        return { ok: true, effects, variables: vars, position: { kind: "ended", status: "COMPLETED" } };
    }
  }

  /*
   * A null edge. The author drew a branch that stops, which validateFlow
   * accepts as an ending - so the run ends, having said nothing more.
   */
  return {
    ok: true,
    effects,
    variables: vars,
    position: { kind: "ended", status: "COMPLETED" },
  };
}
