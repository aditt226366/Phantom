import { encodeReplyButtonId } from "./button-id.ts";
import { INTERACTIVE_LIMITS, type FlowNode, type QuestionNode } from "./nodes.ts";

/**
 * A question node, as the JSON Meta's /messages endpoint takes.
 *
 * Built here rather than in the Graph call for the reason the template
 * components are built in template.ts: this is also what the builder previews
 * and what the thread renders. One producer of the shape means the preview an
 * author approves is the message a customer receives, rather than two
 * renderings that agree until somebody edits one.
 *
 * The ids are the load-bearing part. Every button and every list row carries
 * an id encoding the run and the node that asked - see button-id.ts for why
 * that cannot be retrofitted - and this is the only place they are written.
 */

export interface InteractivePayload {
  type: "button" | "list";
  header?: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  action: Record<string, unknown>;
}

/**
 * Build the payload for one question, for one run.
 *
 * Throws on a node that cannot be expressed - too many buttons, a label over
 * twenty characters - rather than trimming to fit. Trimming is the tempting
 * behaviour and the wrong one: a fourth answer silently dropped is a customer
 * who cannot give the answer they wanted, and nothing anywhere would say so.
 * validateFlow refuses to publish such a node, so reaching this throw means
 * something got into the database another way.
 */
export function buildInteractivePayload(
  node: QuestionNode,
  runId: string,
): InteractivePayload {
  const base = {
    body: { text: node.body },
    ...(node.header ? { header: { type: "text" as const, text: node.header } } : {}),
    ...(node.footer ? { footer: { text: node.footer } } : {}),
  };

  if (node.presentation.as === "buttons") {
    const choices = node.presentation.choices;

    if (choices.length > INTERACTIVE_LIMITS.MAX_BUTTONS) {
      throw new Error(
        `Node "${node.id}" has ${choices.length} reply buttons; Meta allows ${INTERACTIVE_LIMITS.MAX_BUTTONS}.`,
      );
    }

    for (const choice of choices) {
      if (choice.label.length > INTERACTIVE_LIMITS.MAX_BUTTON_LABEL) {
        throw new Error(
          `Reply button "${choice.label}" on node "${node.id}" is ${choice.label.length} characters; Meta allows ${INTERACTIVE_LIMITS.MAX_BUTTON_LABEL}.`,
        );
      }
    }

    return {
      type: "button",
      ...base,
      action: {
        buttons: choices.map((choice) => ({
          type: "reply",
          reply: {
            id: encodeReplyButtonId({ runId, nodeId: node.id, choice: choice.key }),
            title: choice.label,
          },
        })),
      },
    };
  }

  const sections = node.presentation.sections;
  const rows = sections.reduce((n, s) => n + s.choices.length, 0);

  if (rows > INTERACTIVE_LIMITS.MAX_LIST_ROWS) {
    throw new Error(
      `Node "${node.id}" has ${rows} list rows across ${sections.length} sections; Meta allows ${INTERACTIVE_LIMITS.MAX_LIST_ROWS} in total.`,
    );
  }

  return {
    type: "list",
    ...base,
    action: {
      button: node.presentation.button,
      sections: sections.map((section) => ({
        title: section.title,
        rows: section.choices.map((choice) => ({
          id: encodeReplyButtonId({ runId, nodeId: node.id, choice: choice.key }),
          title: choice.label,
          ...(choice.description ? { description: choice.description } : {}),
        })),
      })),
    },
  };
}

/**
 * What the thread shows for an interactive message, and what the inbox
 * previews.
 *
 * The body plus the options, because a thread showing only "How can we help?"
 * beside a customer's "Delivery" leaves an operator unable to see what was
 * offered - and the options are the half a support conversation is about.
 *
 * Deliberately not the ids. They are correct, unique per run, and completely
 * unreadable; a person reading a thread wants the labels.
 */
export function describeInteractive(node: FlowNode): string {
  if (node.kind !== "question") {
    return "body" in node && typeof node.body === "string" ? node.body : "";
  }

  const labels = (
    node.presentation.as === "buttons"
      ? node.presentation.choices
      : node.presentation.sections.flatMap((s) => s.choices)
  ).map((c) => c.label);

  return `${node.body}\n\n${labels.map((l) => `- ${l}`).join("\n")}`;
}
