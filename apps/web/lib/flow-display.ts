import type { FlowRunStatus } from "@whatsapp-os/db";
import type { FlowNodeKind } from "@whatsapp-os/core/flows";

/**
 * How a flow, a version and a run are presented.
 *
 * Extracted from the pages for the reason bulk-display.ts and kyc-display.ts
 * give: a badge choice is a decision with branches, and asserting a rendered
 * substring is not a test of one. A test that a page contains "Paused" stayed
 * green once when the control was deleted, because the word survived in a
 * neighbouring heading. The tests here assert returned values.
 */

export type StatusVariant = "success" | "error" | "default" | "outline";

/** What a flow's own state is called, derived rather than stored. */
export type FlowState = "draft" | "published" | "archived";

export function flowState(flow: {
  publishedVersionId: string | null;
  archivedAt: Date | null;
}): FlowState {
  if (flow.archivedAt) return "archived";
  return flow.publishedVersionId ? "published" : "draft";
}

export function flowStateLabel(state: FlowState): string {
  switch (state) {
    case "draft":
      return "Draft";
    case "published":
      return "Live";
    case "archived":
      return "Archived";
  }
}

/**
 * The chip's colour.
 *
 * Live is the only green, because it is the only one that is a fact about
 * customers being in something right now. Draft is not a problem and archived
 * is not a failure - painting either red would make an ordinary state look
 * like a fault.
 */
export function flowStateVariant(state: FlowState): StatusVariant {
  switch (state) {
    case "published":
      return "success";
    case "draft":
      return "outline";
    case "archived":
      return "default";
  }
}

export function runStatusLabel(status: FlowRunStatus): string {
  switch (status) {
    case "ACTIVE":
      return "In progress";
    case "PAUSED":
      return "Waiting to resume";
    case "COMPLETED":
      return "Finished";
    case "HANDED_OFF":
      return "Handed to a person";
    case "FAILED":
      return "Stopped";
  }
}

/**
 * PAUSED is not an error, and this is the decision worth defending.
 *
 * A run whose 24-hour window shut is the ordinary outcome of a customer not
 * replying for a day. Nothing has gone wrong; the flow cannot speak until
 * spoken to, and it kept its position so the entry template can pick the
 * customer up where they stopped. Colouring it red would send an operator
 * looking for a fault, and there is nothing to find.
 *
 * HANDED_OFF is not an error either - it is the flow doing the right thing -
 * but it is the one state that wants somebody's attention, so it is the one
 * that is not muted.
 */
export function runStatusVariant(status: FlowRunStatus): StatusVariant {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "HANDED_OFF":
      return "outline";
    case "FAILED":
      return "error";
    case "ACTIVE":
    case "PAUSED":
      return "default";
  }
}

/** What the tenant calls each node kind. Never the schema's word. */
export function nodeKindLabel(kind: FlowNodeKind): string {
  switch (kind) {
    case "entry":
      return "Opening template";
    case "message":
      return "Message";
    case "question":
      return "Question";
    case "collect":
      return "Ask for an answer";
    case "branch":
      return "Branch";
    case "action":
      return "Action";
    case "handoff":
      return "Hand to a person";
    case "end":
      return "End";
  }
}

/**
 * The one-line explanation under each kind in the Add menu.
 *
 * The window constraint is stated on the two kinds it decides, rather than in a
 * paragraph at the top of the page that nobody reads twice. An author choosing
 * between a Question and an Opening template is choosing between free-form and
 * approved, and that is the moment the difference matters.
 */
export function nodeKindHint(kind: FlowNodeKind): string {
  switch (kind) {
    case "entry":
      return "An approved template with quick-reply buttons. The only thing that can start a flow, or restart one after 24 hours of silence.";
    case "message":
      return "Text or an image, then straight on to the next step.";
    case "question":
      return "Up to three reply buttons, or a list of up to ten rows. Only works inside the 24-hour window.";
    case "collect":
      return "Ask something and keep whatever the customer types.";
    case "branch":
      return "Send people different ways depending on an answer already given.";
    case "action":
      return "Score the lead, add a tag, or raise the thread for your team.";
    case "handoff":
      return "Stop automating and put the conversation in front of a person.";
    case "end":
      return "Finish, with an optional last message.";
  }
}
