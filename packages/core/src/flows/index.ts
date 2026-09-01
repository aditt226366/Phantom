/**
 * The client-safe half of the flow builder.
 *
 * Everything here must be importable from a "use client" component - the
 * builder's node editors validate as somebody types, against the same module
 * the runtime enforces with. Nothing in this directory reaches for node:crypto,
 * the database or the filesystem, and nothing should start to: the core barrel
 * dragged a native Argon2 binding into the browser graph for six commits
 * before a page rendered and the build noticed.
 */
export {
  BUTTON_ID_SCHEME,
  MAX_BUTTON_ID_LENGTH,
  encodeEntryButtonId,
  encodeReplyButtonId,
  parseButtonId,
} from "./button-id.ts";
export type { ButtonIdParse, ButtonRef } from "./button-id.ts";
export {
  INTERACTIVE_LIMITS,
  MAX_STEPS_PER_ADVANCE,
  MAX_STEPS_PER_RUN,
  choicesOf,
  edgesOf,
  flowGraphSchema,
  flowNodeSchema,
  validateFlow,
} from "./nodes.ts";
export type {
  EntryNode,
  FlowAction,
  FlowChoice,
  FlowGraph,
  FlowIssue,
  FlowNode,
  FlowNodeKind,
  FlowValidation,
  QuestionNode,
} from "./nodes.ts";
export { buildInteractivePayload, describeInteractive } from "./interactive.ts";
export { planAdvance, planEntry } from "./engine.ts";
export type { AdvanceFailure, AdvancePlan, FlowEffect, FlowInput } from "./engine.ts";
export type { InteractivePayload } from "./interactive.ts";
