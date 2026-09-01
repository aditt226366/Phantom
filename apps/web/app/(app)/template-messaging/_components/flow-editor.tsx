"use client";

import { useActionState, useMemo, useState, type ReactNode } from "react";
import {
  INTERACTIVE_LIMITS,
  choicesOf,
  validateFlow,
  type FlowChoice,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind,
} from "@whatsapp-os/core/flows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nodeKindHint, nodeKindLabel } from "@/lib/flow-display";
import { saveFlowAction, publishFlowAction, type FlowFormState } from "../actions";

/**
 * The builder: a structured node list with named connections.
 *
 * ===========================================================================
 * Why this is a list and not a canvas
 * ===========================================================================
 *
 * A drag-and-drop canvas is a dependency, an interaction model and a mobile
 * problem, for a v1 whose whole job is to express a tree. This design system
 * has no canvas primitives - no node, no edge, no viewport, no pan - so a
 * canvas would mean importing a library with its own visual language and then
 * fighting it back onto --wa-* tokens, or building one.
 *
 * A tree is also a thing a list expresses honestly. Every node names where each
 * of its branches goes, by the name of the node it goes to, in a select that
 * cannot point at a node that does not exist. What a canvas adds over that is
 * spatial memory, which matters at fifty nodes and not at eight - and eight is
 * what three reply buttons per question produces.
 *
 * ===========================================================================
 * Validation runs here AND on the server, and they are different things
 * ===========================================================================
 *
 * validateFlow runs on every keystroke, which is the whole reason
 * @whatsapp-os/core/flows is a client-safe barrel. That is feedback: it tells
 * an author that a fourth reply button is not a warning but a message Meta will
 * refuse, at the moment they add it rather than in a customer's thread.
 *
 * The server runs the same function over the bytes that actually arrive, and
 * that is the boundary. Neither is redundant.
 */

export interface FlowEditorProps {
  flowId: string;
  initialGraph: FlowGraph;
  /** Approved templates, for the entry node. Nothing else may open a flow. */
  templates: ReadonlyArray<{ id: string; name: string; language: string }>;
  /** Whether the live version differs from what is being edited. */
  hasUnpublishedChanges: boolean;
  /** The CSRF input, rendered on the server and passed through. */
  csrf: ReactNode;
}

const ADDABLE: readonly FlowNodeKind[] = [
  "question",
  "message",
  "collect",
  "branch",
  "action",
  "handoff",
  "end",
];

export function FlowEditor({
  flowId,
  initialGraph,
  templates,
  hasUnpublishedChanges,
  csrf,
}: FlowEditorProps) {
  const [graph, setGraph] = useState<FlowGraph>(initialGraph);
  const [saveState, save, saving] = useActionState<FlowFormState, FormData>(
    saveFlowAction,
    {},
  );
  const [publishState, publish, publishing] = useActionState<FlowFormState, FormData>(
    publishFlowAction,
    {},
  );

  const validation = useMemo(() => validateFlow(graph), [graph]);

  /* Server-side issues win: they describe the bytes that actually arrived. */
  const issues =
    saveState.issues ??
    publishState.issues ??
    validation.issues.map((i) => ({ nodeId: i.nodeId, message: i.message }));

  const status = publishState.message ?? saveState.message;
  const busy = saving || publishing;

  function patch(id: string, next: FlowNode) {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? next : n)) }));
  }

  function remove(id: string) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes
        .filter((n) => n.id !== id)
        /* Clear every edge that pointed at it, rather than leaving a dangling
           reference for the validator to report. An author deleting a node
           meant to delete it, not to be told about it three times. */
        .map((n) => clearEdgesTo(n, id)),
    }));
  }

  function add(kind: FlowNodeKind) {
    setGraph((g) => ({ ...g, nodes: [...g.nodes, blankNode(kind, nextId(g))] }));
  }

  return (
    <div className="flex flex-col gap-lg">
      <ol className="flex flex-col gap-sm">
        {graph.nodes.map((node) => (
          <li key={node.id}>
            <NodeCard
              node={node}
              nodes={graph.nodes}
              templates={templates}
              issues={issues.filter((i) => i.nodeId === node.id)}
              onChange={(next) => patch(node.id, next)}
              onRemove={node.kind === "entry" ? null : () => remove(node.id)}
            />
          </li>
        ))}
      </ol>

      <section
        aria-labelledby="add-node"
        className="rounded-lg border border-hairline bg-surface-card p-base"
      >
        <h2 id="add-node" className="text-title-sm text-ink">
          Add a step
        </h2>
        <div className="mt-sm flex flex-wrap gap-xs">
          {ADDABLE.map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              onClick={() => add(kind)}
              title={nodeKindHint(kind)}
            >
              {nodeKindLabel(kind)}
            </Button>
          ))}
        </div>
      </section>

      {issues.length > 0 ? (
        <section
          aria-labelledby="flow-issues"
          className="rounded-lg border border-hairline-strong bg-surface-card p-base"
        >
          <h2 id="flow-issues" className="text-title-sm text-ink">
            Fix before publishing
          </h2>
          <ul className="mt-xs flex flex-col gap-xxs">
            {issues.map((issue, index) => (
              <li key={index} className="text-caption text-error">
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-sm">
        <form action={save}>
          {csrf}
          <input type="hidden" name="flowId" value={flowId} />
          <input type="hidden" name="graph" value={JSON.stringify(graph)} />
          <Button type="submit" variant="outline" disabled={busy}>
            Save draft
          </Button>
        </form>

        <form action={publish}>
          {csrf}
          <input type="hidden" name="flowId" value={flowId} />
          <input type="hidden" name="graph" value={JSON.stringify(graph)} />
          <Button type="submit" disabled={busy || !validation.ok}>
            Publish
          </Button>
        </form>

        {hasUnpublishedChanges ? (
          <p className="text-caption text-muted">
            The live version is older than this draft. Conversations already in
            progress stay on the version they started.
          </p>
        ) : null}
      </div>

      <FormStatus
        message={status}
        tone={
          publishState.issues || saveState.issues || saveState.message === undefined
            ? "error"
            : "success"
        }
      />
    </div>
  );
}

/* ==========================================================================
   One node
   ========================================================================== */

interface NodeCardProps {
  node: FlowNode;
  nodes: readonly FlowNode[];
  templates: FlowEditorProps["templates"];
  issues: ReadonlyArray<{ message: string }>;
  onChange: (next: FlowNode) => void;
  onRemove: (() => void) | null;
}

function NodeCard({ node, nodes, templates, issues, onChange, onRemove }: NodeCardProps) {
  return (
    <article className="rounded-lg border border-hairline bg-surface-card p-base">
      <header className="flex flex-wrap items-center justify-between gap-xs">
        <div className="flex items-center gap-xs">
          <Badge variant={node.kind === "entry" ? "default" : "outline"}>
            {nodeKindLabel(node.kind)}
          </Badge>
          <span className="text-caption text-muted">{node.id}</span>
        </div>
        {onRemove ? (
          <Button type="button" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </header>

      <div className="mt-sm flex flex-col gap-sm">
        <NodeFields node={node} nodes={nodes} templates={templates} onChange={onChange} />
      </div>

      {issues.length > 0 ? (
        <ul className="mt-sm flex flex-col gap-xxs">
          {issues.map((issue, index) => (
            <li key={index} className="text-caption text-error">
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function NodeFields({
  node,
  nodes,
  templates,
  onChange,
}: Omit<NodeCardProps, "issues" | "onRemove">) {
  const targets = nodes.filter((n) => n.id !== node.id);

  switch (node.kind) {
    case "entry":
      return (
        <>
          <Labelled label="Opening template" hint={nodeKindHint("entry")}>
            <Select
              value={node.templateId}
              onChange={(templateId) => onChange({ ...node, templateId })}
              options={templates.map((t) => ({
                value: t.id,
                label: `${t.name} (${t.language})`,
              }))}
            />
          </Labelled>
          <Choices
            node={node}
            targets={targets}
            max={INTERACTIVE_LIMITS.MAX_BUTTONS}
            label="Its quick-reply buttons, in the order Meta approved them"
            onChange={(choices) => onChange({ ...node, choices })}
          />
        </>
      );

    case "message":
      return (
        <>
          <Labelled label="Message">
            <Textarea
              value={node.body}
              onChange={(body) => onChange({ ...node, body })}
            />
          </Labelled>
          <Labelled label="Then go to">
            <NodeSelect
              value={node.next}
              targets={targets}
              onChange={(next) => onChange({ ...node, next })}
            />
          </Labelled>
        </>
      );

    case "question":
      return (
        <>
          <Labelled label="Question" hint={nodeKindHint("question")}>
            <Textarea value={node.body} onChange={(body) => onChange({ ...node, body })} />
          </Labelled>
          <Labelled
            label="Remember the answer as"
            hint="Optional. A later branch can send people different ways depending on it."
          >
            <Input
              value={node.variable ?? ""}
              onChange={(e) =>
                onChange({ ...node, variable: e.target.value.trim() || null })
              }
              placeholder="want"
            />
          </Labelled>
          {node.presentation.as === "buttons" ? (
            <Choices
              node={node}
              targets={targets}
              max={INTERACTIVE_LIMITS.MAX_BUTTONS}
              label={`Reply buttons (up to ${INTERACTIVE_LIMITS.MAX_BUTTONS}, ${INTERACTIVE_LIMITS.MAX_BUTTON_LABEL} characters each)`}
              onChange={(choices) =>
                onChange({ ...node, presentation: { as: "buttons", choices } })
              }
            />
          ) : (
            <p className="text-caption text-muted">
              This question is a list. Lists are edited as sections of rows, and
              Meta allows {INTERACTIVE_LIMITS.MAX_LIST_ROWS} rows across all of
              them together.
            </p>
          )}
        </>
      );

    case "collect":
      return (
        <>
          <Labelled label="What to ask">
            <Textarea value={node.body} onChange={(body) => onChange({ ...node, body })} />
          </Labelled>
          <Labelled label="Keep the answer as">
            <Input
              value={node.variable}
              onChange={(e) => onChange({ ...node, variable: e.target.value.trim() })}
              placeholder="size"
            />
          </Labelled>
          <Labelled label="Then go to">
            <NodeSelect
              value={node.next}
              targets={targets}
              onChange={(next) => onChange({ ...node, next })}
            />
          </Labelled>
        </>
      );

    case "branch":
      return (
        <>
          <Labelled label="Look at" hint={nodeKindHint("branch")}>
            <Input
              value={node.variable}
              onChange={(e) => onChange({ ...node, variable: e.target.value.trim() })}
            />
          </Labelled>
          {node.cases.map((branch, index) => (
            <div key={index} className="flex flex-wrap items-end gap-xs">
              <Labelled label="When it is exactly">
                <Input
                  value={branch.equals}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      cases: node.cases.map((c, i) =>
                        i === index ? { ...c, equals: e.target.value } : c,
                      ),
                    })
                  }
                />
              </Labelled>
              <Labelled label="Go to">
                <NodeSelect
                  value={branch.next}
                  targets={targets}
                  onChange={(next) =>
                    onChange({
                      ...node,
                      cases: node.cases.map((c, i) => (i === index ? { ...c, next } : c)),
                    })
                  }
                />
              </Labelled>
            </div>
          ))}
          <Labelled
            label="Anything else goes to"
            hint="Including a customer who never reached the question that sets it."
          >
            <NodeSelect
              value={node.fallback}
              targets={targets}
              onChange={(fallback) => onChange({ ...node, fallback })}
            />
          </Labelled>
        </>
      );

    case "action":
      return (
        <>
          <Labelled label="Do this" hint={nodeKindHint("action")}>
            <Select
              value={node.actions[0]?.kind ?? "set_score"}
              onChange={(kind) =>
                onChange({
                  ...node,
                  actions: [
                    kind === "set_score"
                      ? { kind: "set_score", score: "HOT" }
                      : kind === "add_tag"
                        ? { kind: "add_tag", tag: "interested" }
                        : { kind: "notify", note: "Somebody should look at this." },
                  ],
                })
              }
              options={[
                { value: "set_score", label: "Set the lead temperature" },
                { value: "add_tag", label: "Add a tag to the contact" },
                { value: "notify", label: "Raise the thread for the team" },
              ]}
            />
          </Labelled>
          <ActionFields node={node} onChange={onChange} />
          <Labelled label="Then go to">
            <NodeSelect
              value={node.next}
              targets={targets}
              onChange={(next) => onChange({ ...node, next })}
            />
          </Labelled>
        </>
      );

    case "handoff":
      return (
        <>
          <Labelled label="Last message to the customer" hint={nodeKindHint("handoff")}>
            <Textarea
              value={node.body ?? ""}
              onChange={(body) => onChange({ ...node, body: body || null })}
            />
          </Labelled>
          <Labelled label="Note for your team">
            <Input
              value={node.note ?? ""}
              onChange={(e) => onChange({ ...node, note: e.target.value || null })}
            />
          </Labelled>
        </>
      );

    case "end":
      return (
        <Labelled label="Last message" hint="Leave it empty to finish silently.">
          <Textarea
            value={node.body ?? ""}
            onChange={(body) => onChange({ ...node, body: body || null })}
          />
        </Labelled>
      );
  }
}

function ActionFields({
  node,
  onChange,
}: {
  node: Extract<FlowNode, { kind: "action" }>;
  onChange: (next: FlowNode) => void;
}) {
  const action = node.actions[0];
  if (!action) return null;

  if (action.kind === "set_score") {
    return (
      <Labelled label="Temperature">
        <Select
          value={action.score}
          onChange={(score) =>
            onChange({
              ...node,
              actions: [{ kind: "set_score", score: score as "HOT" | "WARM" | "COLD" }],
            })
          }
          options={[
            { value: "HOT", label: "Hot" },
            { value: "WARM", label: "Warm" },
            { value: "COLD", label: "Cold" },
          ]}
        />
      </Labelled>
    );
  }

  if (action.kind === "add_tag") {
    return (
      <Labelled label="Tag">
        <Input
          value={action.tag}
          onChange={(e) =>
            onChange({ ...node, actions: [{ kind: "add_tag", tag: e.target.value }] })
          }
        />
      </Labelled>
    );
  }

  return (
    <Labelled label="Note" hint="Marks the thread unread so it surfaces in the inbox.">
      <Input
        value={action.note}
        onChange={(e) =>
          onChange({ ...node, actions: [{ kind: "notify", note: e.target.value }] })
        }
      />
    </Labelled>
  );
}

/* ==========================================================================
   Small pieces
   ========================================================================== */

function Choices({
  node,
  targets,
  max,
  label,
  onChange,
}: {
  node: FlowNode;
  targets: readonly FlowNode[];
  max: number;
  label: string;
  onChange: (choices: FlowChoice[]) => void;
}) {
  const choices = choicesOf(node);

  return (
    <fieldset className="flex flex-col gap-xs">
      <legend className="text-caption text-muted">{label}</legend>
      {choices.map((choice, index) => (
        <div key={index} className="flex flex-wrap items-end gap-xs">
          <Labelled label="Button text">
            <Input
              value={choice.label}
              maxLength={INTERACTIVE_LIMITS.MAX_BUTTON_LABEL}
              onChange={(e) =>
                onChange(
                  choices.map((c, i) =>
                    i === index ? { ...c, label: e.target.value } : c,
                  ),
                )
              }
            />
          </Labelled>
          <Labelled label="Goes to">
            <NodeSelect
              value={choice.next}
              targets={targets}
              onChange={(next) =>
                onChange(choices.map((c, i) => (i === index ? { ...c, next } : c)))
              }
            />
          </Labelled>
          {choices.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(choices.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ))}

      {choices.length < max ? (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onChange([
                ...choices,
                {
                  /*
                   * A key that cannot collide, because a tap carries it and two
                   * choices sharing one are indistinguishable when it comes
                   * back. Derived from the position at creation and then left
                   * alone - renaming a key would orphan every button already in
                   * a customer's chat.
                   */
                  key: `c${choices.length + 1}${Math.random().toString(36).slice(2, 6)}`,
                  label: "Option",
                  next: null,
                },
              ])
            }
          >
            Add a button
          </Button>
        </div>
      ) : (
        <p className="text-caption text-muted">
          Meta allows {max}. A question that needs more answers is a list.
        </p>
      )}
    </fieldset>
  );
}

function NodeSelect({
  value,
  targets,
  onChange,
}: {
  value: string | null;
  targets: readonly FlowNode[];
  onChange: (next: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onChange={(next) => onChange(next || null)}
      options={[
        { value: "", label: "Nothing - the flow ends here" },
        ...targets.map((n) => ({
          value: n.id,
          label: `${nodeKindLabel(n.kind)} · ${n.id}`,
        })),
      ]}
    />
  );
}

/**
 * A native select on the system's input geometry.
 *
 * Not a pill: inputs are the one place in this system that are not. 8px radius,
 * 44px tall, hairline thickening to an ink ring on focus - the same metrics
 * Input uses, because a select beside an input at different heights is the kind
 * of thing nobody can name and everybody sees.
 */
function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-input w-full rounded-md border border-hairline-strong bg-surface-card px-sm text-body-sm text-ink focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Textarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      maxLength={INTERACTIVE_LIMITS.MAX_BODY}
      className="w-full rounded-md border border-hairline-strong bg-surface-card px-sm py-xs text-body-sm text-ink focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
    />
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <Label className="text-caption text-muted">{label}</Label>
      {hint ? <p className="mb-xxs text-caption text-muted-soft">{hint}</p> : null}
      {children}
    </div>
  );
}

/* ==========================================================================
   Graph edits
   ========================================================================== */

/** The next free node id. Generated, never typed: it goes into a button id. */
function nextId(graph: FlowGraph): string {
  for (let n = graph.nodes.length + 1; ; n++) {
    const candidate = `n${n}`;
    if (!graph.nodes.some((node) => node.id === candidate)) return candidate;
  }
}

function blankNode(kind: FlowNodeKind, id: string): FlowNode {
  switch (kind) {
    case "question":
      return {
        id,
        kind,
        body: "What can we help with?",
        variable: null,
        presentation: {
          as: "buttons",
          choices: [{ key: "c1", label: "Option", next: null }],
        },
      };
    case "message":
      return { id, kind, body: "", mediaId: null, next: null };
    case "collect":
      return { id, kind, body: "", variable: "answer", next: null };
    case "branch":
      return { id, kind, variable: "answer", cases: [{ equals: "", next: null }], fallback: null };
    case "action":
      return { id, kind, actions: [{ kind: "set_score", score: "HOT" }], next: null };
    case "handoff":
      return { id, kind, body: null, note: null };
    case "end":
      return { id, kind, body: null };
    case "entry":
      /* Unreachable: ADDABLE excludes it, because a flow has exactly one and it
         is created with the flow. Present so the switch is exhaustive. */
      return { id, kind, templateId: "", variables: [], choices: [] };
  }
}

/** Every edge pointing at a deleted node, set back to "ends here". */
function clearEdgesTo(node: FlowNode, deleted: string): FlowNode {
  const drop = (next: string | null) => (next === deleted ? null : next);

  switch (node.kind) {
    case "entry":
      return { ...node, choices: node.choices.map((c) => ({ ...c, next: drop(c.next) })) };
    case "question":
      return node.presentation.as === "buttons"
        ? {
            ...node,
            presentation: {
              as: "buttons",
              choices: node.presentation.choices.map((c) => ({ ...c, next: drop(c.next) })),
            },
          }
        : {
            ...node,
            presentation: {
              ...node.presentation,
              sections: node.presentation.sections.map((s) => ({
                ...s,
                choices: s.choices.map((c) => ({ ...c, next: drop(c.next) })),
              })),
            },
          };
    case "message":
    case "collect":
    case "action":
      return { ...node, next: drop(node.next) };
    case "branch":
      return {
        ...node,
        cases: node.cases.map((c) => ({ ...c, next: drop(c.next) })),
        fallback: drop(node.fallback),
      };
    case "handoff":
    case "end":
      return node;
  }
}
