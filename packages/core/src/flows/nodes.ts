import { z } from "zod";

/**
 * The node vocabulary, and the limits a tree has to satisfy before it can ship.
 *
 * ===========================================================================
 * Meta's limits are the design, not a validation detail
 * ===========================================================================
 *
 * Three reply buttons of twenty characters. Ten list rows. That is the entire
 * expressive budget of a flow, and every interesting shape in this file is a
 * consequence of it - a question with four answers is not a question that
 * needs a warning, it is a question that cannot be sent, and finding that out
 * from Meta at send time means finding out in a customer's thread.
 *
 * So the limits live here, beside the schemas, and validateFlow is run by the
 * builder before publish and by the runtime before it trusts a version. Both,
 * because they answer different questions: the builder is telling an author
 * what to fix, and the runtime is refusing to send something malformed no
 * matter how it got into the database.
 *
 * ===========================================================================
 * Why the entry node is its own kind
 * ===========================================================================
 *
 * Interactive messages need no approval and can be edited and republished in
 * seconds, which is what makes a visual builder possible at all. They also
 * only work INSIDE the 24-hour customer service window. An approved template
 * with quick-reply buttons is therefore the only legal way to start a flow,
 * and the only way to resume one whose window has lapsed.
 *
 * That is not a property of the runtime that can be checked later - it is a
 * different message type, sent through a different Graph shape, with buttons
 * Meta approved rather than buttons we wrote. Making it a distinct node kind
 * means a flow cannot be built that starts with an interactive message, which
 * is a flow that would appear to work for every customer who wrote in today
 * and silently fail for everybody else.
 *
 * ===========================================================================
 * Cycles are legal, and the ceiling is what makes them safe
 * ===========================================================================
 *
 * "Back to the main menu" is an ordinary thing to draw and validateFlow does
 * not reject it. What would be unsafe is a cycle with no customer input in it -
 * message, action, message, back to the first - which the engine would walk
 * for ever, sending as it went.
 *
 * Two things stop that, and they are deliberately different in kind. The
 * ceiling below is a hard stop on any single advance, so nothing can run away
 * even if the graph is pathological in a way this file did not anticipate.
 * And validateFlow refuses a loop containing no waiting node, which is the
 * same fault caught earlier, with a sentence naming the nodes involved rather
 * than a run that dies at step fifty.
 */

/* ==========================================================================
   Meta's limits
   ========================================================================== */

/**
 * Reply buttons and lists, as documented by Meta for interactive messages.
 *
 * Kept as one frozen object rather than loose constants so that the builder's
 * hints, the validator and the payload builder cannot disagree about a number.
 * Every one of these is Meta's, not a product decision, and changing one to
 * make a flow fit would move the failure to the Graph call.
 */
export const INTERACTIVE_LIMITS = {
  /** Reply buttons per message. Three is the hard ceiling. */
  MAX_BUTTONS: 3,
  /** Characters in a reply button's visible label. */
  MAX_BUTTON_LABEL: 20,
  /** Rows across ALL sections of a list, not per section. */
  MAX_LIST_ROWS: 10,
  MAX_LIST_SECTIONS: 10,
  MAX_LIST_SECTION_TITLE: 24,
  MAX_LIST_ROW_TITLE: 24,
  MAX_LIST_ROW_DESCRIPTION: 72,
  /** The text of the list's own opening button. */
  MAX_LIST_BUTTON_LABEL: 20,
  MAX_BODY: 1024,
  MAX_HEADER: 60,
  MAX_FOOTER: 60,
} as const;

/**
 * How many nodes one advance may walk before the engine gives up.
 *
 * The guard of last resort against a cycle with no customer input in it. Fifty
 * is far above any real flow - a tree a person can reason about is a handful of
 * steps deep - and far below anything that would cost real money before it
 * stopped.
 *
 * A run that hits it is FAILED and says so, rather than paused: paused means
 * "waiting for the customer", and nothing here is waiting for anybody. An
 * operator seeing a paused run would wait for a tap that is never coming.
 */
export const MAX_STEPS_PER_ADVANCE = 50;

/**
 * How many steps a run may accumulate over its whole life.
 *
 * Separate from the per-advance ceiling and larger, because a legitimate menu
 * loop is a customer choosing to go round again - each pass is a tap, each tap
 * is consent, and cutting them off at fifty would end a conversation somebody
 * is actively having. What this stops is the pathological case the other
 * ceiling cannot see: a flow that advances two steps per tap, for ever.
 */
export const MAX_STEPS_PER_RUN = 500;

/* ==========================================================================
   Identifiers
   ========================================================================== */

/**
 * Node ids and choice keys go into button ids, so their alphabet is that
 * module's alphabet and their caps are inside its caps.
 *
 * Enforced here rather than left to encodeReplyButtonId's throw, because the
 * moment to find out is when an author names a node - not when a customer taps
 * a button and the send throws inside a worker.
 */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,32}$/;
const nodeIdSchema = z.string().regex(IDENTIFIER, "Node ids are 1-32 characters of letters, digits, dash or underscore");
const choiceKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Choice keys are 1-40 characters of letters, digits, dash or underscore");

/**
 * Variable names are the tenant's, and they appear in branch conditions.
 *
 * Deliberately narrower than the node alphabet: no dash, because a branch
 * condition reading `order-status` invites being read as a subtraction by the
 * next person to add an expression language. There is no expression language
 * and there is not going to be one - a branch is equality against a stored
 * string - but the name should not suggest otherwise.
 */
const variableNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "Variable names start with a letter and contain lowercase letters, digits or underscore");

/* ==========================================================================
   Node schemas
   ========================================================================== */

/** Where a node goes next. Null is a legal ending - the run stops there. */
const nextSchema = nodeIdSchema.nullable();

const choiceSchema = z.object({
  /** Goes into the button id. Stable across edits: renaming it is a new key. */
  key: choiceKeySchema,
  label: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_BUTTON_LABEL),
  /** Lists only. Meta ignores it on a reply button. */
  description: z.string().max(INTERACTIVE_LIMITS.MAX_LIST_ROW_DESCRIPTION).optional(),
  next: nextSchema,
});

export type FlowChoice = z.infer<typeof choiceSchema>;

const listSectionSchema = z.object({
  title: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_LIST_SECTION_TITLE),
  choices: z.array(choiceSchema).min(1),
});

/**
 * Which action an action node performs.
 *
 * A closed union rather than a name and a bag of arguments, because each of
 * these writes to a different table and the write is not generic. `set_score`
 * is the one that makes A1 land a real dashboard card rather than a promise -
 * the moment a flow can set a lead's temperature, "Lead temperature" stops
 * being a pending card and becomes a chart with data behind it.
 */
const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_score"),
    score: z.enum(["HOT", "WARM", "COLD"]),
  }),
  z.object({
    kind: z.literal("add_tag"),
    /** Free text the tenant chose. Stored on the contact, shown in the inbox. */
    tag: z.string().min(1).max(40),
  }),
  z.object({
    kind: z.literal("notify"),
    /**
     * Raises the thread in the inbox by marking it unread, and records the
     * note on the run step.
     *
     * Deliberately not an email or a push. Neither exists in this system yet,
     * and an action node that silently did nothing would be the worst kind of
     * automation - an author would draw it, believe somebody was told, and
     * find out from a customer.
     */
    note: z.string().min(1).max(280),
  }),
]);

export type FlowAction = z.infer<typeof actionSchema>;

/**
 * The entry: an approved template with quick-reply buttons.
 *
 * `choices` are positional against the template's own buttons - Meta defines
 * them at approval time and takes only a payload per index at send time - so
 * the order here IS the order there, and validateFlow checks the count against
 * what the template actually has when the builder supplies it.
 */
const entryNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("entry"),
  /** Our template row, not Meta's id. Resolved at send time. */
  templateId: z.string().min(1),
  /** Values for the template's positional variables, in Meta's order. */
  variables: z.array(z.string()).max(20).default([]),
  choices: z.array(choiceSchema).min(1).max(INTERACTIVE_LIMITS.MAX_BUTTONS),
});

/** Text or media, then straight on. Nothing waits here. */
const messageNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("message"),
  body: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_BODY),
  /** A stored media row. Null sends text alone. */
  mediaId: z.string().min(1).nullable().default(null),
  next: nextSchema,
});

/** A question with buttons or a list. This is where a run waits for a tap. */
const questionNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("question"),
  body: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_BODY),
  header: z.string().max(INTERACTIVE_LIMITS.MAX_HEADER).optional(),
  footer: z.string().max(INTERACTIVE_LIMITS.MAX_FOOTER).optional(),
  /** Stores the chosen key, so a later branch can read what they picked. */
  variable: variableNameSchema.nullable().default(null),
  presentation: z.discriminatedUnion("as", [
    z.object({ as: z.literal("buttons"), choices: z.array(choiceSchema).min(1).max(INTERACTIVE_LIMITS.MAX_BUTTONS) }),
    z.object({
      as: z.literal("list"),
      /** The label on the button that opens the list. */
      button: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_LIST_BUTTON_LABEL),
      sections: z.array(listSectionSchema).min(1).max(INTERACTIVE_LIMITS.MAX_LIST_SECTIONS),
    }),
  ]),
});

/** Ask, then wait for whatever the customer types. */
const collectNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("collect"),
  body: z.string().min(1).max(INTERACTIVE_LIMITS.MAX_BODY),
  variable: variableNameSchema,
  next: nextSchema,
});

/** No message. Reads a variable and routes. */
const branchNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("branch"),
  variable: variableNameSchema,
  /**
   * Equality against a stored string, in order, first match wins.
   *
   * Not an expression language, and the absence is the feature: the product
   * being sold is a flow whose author can predict it, and every operator on
   * every comparison is a way for two people to read one branch differently.
   */
  cases: z.array(z.object({ equals: z.string().max(200), next: nextSchema })).min(1).max(20),
  /** Where an unmatched value goes. Null ends the run. */
  fallback: nextSchema,
});

/** No message. Writes something down and carries on. */
const actionNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("action"),
  actions: z.array(actionSchema).min(1).max(10),
  next: nextSchema,
});

/** Stop automating and put the thread in front of a person. */
const handoffNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("handoff"),
  /** Sent to the customer first, when set. Usually "someone will be in touch". */
  body: z.string().max(INTERACTIVE_LIMITS.MAX_BODY).nullable().default(null),
  note: z.string().max(280).nullable().default(null),
});

/** Stop, with nothing more to say. */
const endNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.literal("end"),
  body: z.string().max(INTERACTIVE_LIMITS.MAX_BODY).nullable().default(null),
});

export const flowNodeSchema = z.discriminatedUnion("kind", [
  entryNodeSchema,
  messageNodeSchema,
  questionNodeSchema,
  collectNodeSchema,
  branchNodeSchema,
  actionNodeSchema,
  handoffNodeSchema,
  endNodeSchema,
]);

export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowNodeKind = FlowNode["kind"];
export type EntryNode = z.infer<typeof entryNodeSchema>;
export type QuestionNode = z.infer<typeof questionNodeSchema>;

export const flowGraphSchema = z.object({
  /** Which node the run starts at. Must be the entry node. */
  entryNodeId: nodeIdSchema,
  nodes: z.array(flowNodeSchema).min(1).max(200),
});

export type FlowGraph = z.infer<typeof flowGraphSchema>;

/* ==========================================================================
   Validation
   ========================================================================== */

export interface FlowIssue {
  /** A machine code, for the same reason SendRefusal is one. */
  code:
    | "unparseable"
    | "entry_missing"
    | "entry_not_entry_node"
    | "entry_duplicated"
    | "duplicate_node_id"
    | "duplicate_choice_key"
    | "dangling_edge"
    | "unreachable_node"
    | "no_ending"
    | "list_rows_over_limit"
    | "loop_without_input";
  /** Which node it is about, when it is about one. */
  nodeId: string | null;
  /** The sentence the builder shows. One wording, defined once. */
  message: string;
}

export interface FlowValidation {
  ok: boolean;
  issues: FlowIssue[];
}

/** The kinds that stop and wait for the customer. */
const WAITING_KINDS = new Set<FlowNodeKind>(["entry", "question", "collect"]);

/** The kinds that end a run. */
const TERMINAL_KINDS = new Set<FlowNodeKind>(["handoff", "end"]);

/** Every node id this node can hand control to. */
export function edgesOf(node: FlowNode): string[] {
  switch (node.kind) {
    case "entry":
      return node.choices.map((c) => c.next).filter((n): n is string => n !== null);
    case "question":
      return (
        node.presentation.as === "buttons"
          ? node.presentation.choices
          : node.presentation.sections.flatMap((s) => s.choices)
      )
        .map((c) => c.next)
        .filter((n): n is string => n !== null);
    case "message":
    case "collect":
    case "action":
      return node.next === null ? [] : [node.next];
    case "branch":
      return [...node.cases.map((c) => c.next), node.fallback].filter(
        (n): n is string => n !== null,
      );
    case "handoff":
    case "end":
      return [];
  }
}

/** Every choice on a node, flattened. Buttons and list rows are one thing here. */
export function choicesOf(node: FlowNode): FlowChoice[] {
  if (node.kind === "entry") return node.choices;
  if (node.kind !== "question") return [];
  return node.presentation.as === "buttons"
    ? node.presentation.choices
    : node.presentation.sections.flatMap((s) => s.choices);
}

/**
 * Everything a tree has to satisfy before it may be published or run.
 *
 * Returns every issue rather than the first, because an author fixing one at a
 * time through a round trip to a validator is an author who stops using the
 * builder. The order is structural first, then reachability - a dangling edge
 * makes half the reachability findings noise, so those are suppressed while
 * edges are broken.
 */
export function validateFlow(raw: unknown): FlowValidation {
  const parsed = flowGraphSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "unparseable" as const,
        nodeId: null,
        message: `${issue.path.join(".") || "flow"}: ${issue.message}`,
      })),
    };
  }

  const graph = parsed.data;
  const issues: FlowIssue[] = [];
  const byId = new Map<string, FlowNode>();

  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        nodeId: node.id,
        message: `Two nodes are called "${node.id}". Node ids have to be unique - a button id naming this one could mean either.`,
      });
      continue;
    }
    byId.set(node.id, node);
  }

  /* Exactly one entry, and it is the root. */
  const entries = graph.nodes.filter((n) => n.kind === "entry");

  if (entries.length === 0) {
    issues.push({
      code: "entry_missing",
      nodeId: null,
      message:
        "A flow needs one entry node. An approved template with quick-reply buttons is the only thing that can start a flow, or restart one whose 24-hour window has closed.",
    });
  } else if (entries.length > 1) {
    issues.push({
      code: "entry_duplicated",
      nodeId: entries[1]!.id,
      message: "A flow has exactly one entry node. Two would be two flows.",
    });
  }

  const root = byId.get(graph.entryNodeId);

  if (!root) {
    issues.push({
      code: "entry_missing",
      nodeId: graph.entryNodeId,
      message: `The flow starts at "${graph.entryNodeId}", which is not a node in it.`,
    });
  } else if (root.kind !== "entry") {
    issues.push({
      code: "entry_not_entry_node",
      nodeId: root.id,
      message: `The flow starts at "${root.id}", which is a ${root.kind} node. Only a template can open a conversation - an interactive message needs the 24-hour window to already be open.`,
    });
  }

  /* Choice keys, per node. They are what a button id carries. */
  for (const node of byId.values()) {
    const seen = new Set<string>();
    for (const choice of choicesOf(node)) {
      if (seen.has(choice.key)) {
        issues.push({
          code: "duplicate_choice_key",
          nodeId: node.id,
          message: `"${node.id}" has two choices keyed "${choice.key}". A tap carries the key, so the two are indistinguishable when it comes back.`,
        });
      }
      seen.add(choice.key);
    }

    /* Meta counts list rows across every section, not per section. */
    if (node.kind === "question" && node.presentation.as === "list") {
      const rows = node.presentation.sections.reduce((n, s) => n + s.choices.length, 0);
      if (rows > INTERACTIVE_LIMITS.MAX_LIST_ROWS) {
        issues.push({
          code: "list_rows_over_limit",
          nodeId: node.id,
          message: `"${node.id}" has ${rows} list rows. Meta allows ${INTERACTIVE_LIMITS.MAX_LIST_ROWS} across all sections together.`,
        });
      }
    }
  }

  /* Dangling edges. */
  let dangling = false;
  for (const node of byId.values()) {
    for (const target of edgesOf(node)) {
      if (!byId.has(target)) {
        dangling = true;
        issues.push({
          code: "dangling_edge",
          nodeId: node.id,
          message: `"${node.id}" points at "${target}", which does not exist.`,
        });
      }
    }
  }

  /*
   * Reachability and endings, only once the edges resolve.
   *
   * A single dangling edge orphans everything behind it, so running these over
   * a broken graph produces a page of findings that all disappear when one
   * typo is fixed - which teaches an author to ignore the list.
   */
  if (!dangling && root && root.kind === "entry") {
    const reachable = new Set<string>();
    const stack = [root.id];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const target of edgesOf(byId.get(id)!)) stack.push(target);
    }

    for (const node of byId.values()) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: "unreachable_node",
          nodeId: node.id,
          message: `Nothing leads to "${node.id}". A customer can never arrive there.`,
        });
      }
    }

    const hasEnding = [...reachable].some((id) => {
      const node = byId.get(id)!;
      return TERMINAL_KINDS.has(node.kind) || edgesOf(node).length === 0;
    });

    if (!hasEnding) {
      issues.push({
        code: "no_ending",
        nodeId: null,
        message:
          "No path through this flow ends. Every branch has to reach an end or a handoff, or a customer is left in it.",
      });
    }

    const loop = findInputlessLoop(byId, root.id, reachable);
    if (loop) {
      issues.push({
        code: "loop_without_input",
        nodeId: loop[0] ?? null,
        message: `These nodes loop with nothing waiting for the customer in between: ${loop.join(" -> ")}. The run would send its way round for ever.`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * A cycle containing no node that waits for the customer.
 *
 * The one graph shape the engine cannot survive on its own merits: message,
 * action, message, back to the first, with no tap anywhere in it. The ceiling
 * stops the run, but the run has already sent whatever it sent on the way -
 * so this is caught at publish, where the cost is a sentence instead of a
 * thread full of messages nobody asked for.
 *
 * Depth-first over the subgraph of non-waiting nodes only. Edges LEAVING a
 * waiting node are not followed, because arriving at one ends the advance -
 * which is precisely what makes a loop through one harmless.
 */
function findInputlessLoop(
  byId: Map<string, FlowNode>,
  rootId: string,
  reachable: ReadonlySet<string>,
): string[] | null {
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const colour = new Map<string, number>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const node = byId.get(id);
    if (!node) return null;

    const state = colour.get(id) ?? WHITE;
    if (state === GREY) {
      /* Back edge: the cycle is the tail of the current path. */
      return [...path.slice(path.indexOf(id)), id];
    }
    if (state === BLACK) return null;

    colour.set(id, GREY);
    path.push(id);

    /* Arriving at a waiting node ends the advance, so its edges are another
       advance's problem and cannot be part of this cycle. */
    if (!WAITING_KINDS.has(node.kind)) {
      for (const target of edgesOf(node)) {
        const found = visit(target);
        if (found) return found;
      }
    }

    path.pop();
    colour.set(id, BLACK);
    return null;
  };

  /* Every reachable node is a candidate start: a loop need not include the
     root, and one hanging off a branch three levels down is the likely shape. */
  for (const id of reachable) {
    if ((colour.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }

  return visit(rootId);
}
