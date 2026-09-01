/**
 * The client-safe half of lead sources.
 *
 * Everything reachable from here must be importable from a "use client"
 * component: the mapping screen renders a live preview of the first three
 * messages, and it does it by running the same functions the poll job runs.
 * Two implementations of "what will this row send" is how a preview ends up
 * showing a message nobody receives.
 *
 * `rowHash` and the cursor are deliberately NOT here. They reach for
 * node:crypto, which is a native module in a browser bundle and a build failure
 * whose import trace names every file except the problem. They live at
 * `@whatsapp-os/core/leads-server`, the way kyc/upload and whatsapp/signature
 * already do - and nothing on a page needs them: a preview shows what a row
 * would send, never whether it already has.
 */
export {
  LEAD_SOURCE_ACTIONS,
  POLL_INTERVAL_DEFAULT_SECONDS,
  POLL_INTERVAL_MAX_SECONDS,
  POLL_INTERVAL_MIN_SECONDS,
  clampPollInterval,
  leadSourceActionSchema,
  parseLeadSourceAction,
  parseSheetRef,
  pollIntervalSchema,
  flowActionSchema,
  templateActionSchema,
} from "./binding.ts";
export type {
  LeadSourceAction,
  LeadSourceActionKind,
  SheetRefResult,
  FlowAction as LeadSourceFlowAction,
  TemplateAction,
} from "./binding.ts";
export {
  APPS_SCRIPT_TIMEOUT_SECONDS,
  appsScriptSource,
  leadSourceWebhookUrl,
} from "./apps-script.ts";
export { PREVIEW_ROWS, toRecords } from "./rows.ts";
export type { SheetContent } from "./rows.ts";
