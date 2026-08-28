/**
 * The client-safe half of the WhatsApp layer.
 *
 * Everything reachable from here must be importable from a "use client"
 * component. The template preview will be one, and it renders from the same
 * module the submission is built from - which is the whole point of decision 10
 * and the reason this barrel exists at all.
 *
 * node:crypto, database access and anything else server-only belongs in
 * @whatsapp-os/core/whatsapp-server. The failure mode is not a compile error:
 * the core barrel dragged @node-rs/argon2 into the browser graph for six
 * commits before a page rendered and the build noticed.
 */
export {
  MESSAGE_STATUSES,
  advanceStatus,
  isRankedStatus,
  statusFromMeta,
  statusRank,
  statusRankSqlCase,
  statusesBelow,
} from "./status.ts";
export type { MessageStatusName } from "./status.ts";
export {
  CUSTOMER_SERVICE_WINDOW_MS,
  describeWindow,
  isWindowOpen,
  windowExpiryFor,
} from "./window.ts";
export type { WindowState } from "./window.ts";
export { sendPolicy } from "./send-policy.ts";
export type { SendDecision, SendFacts, SendIntent, SendRefusal } from "./send-policy.ts";
/* The cap lives with the send/receive shapes in graph.ts; it is re-exported
   here because the callers that need it are the media ones. */
export { MAX_MEDIA_BYTES, markWhatsAppRead, sendWhatsAppText } from "./graph.ts";
export type { SendAccepted, SendOutcome, SendRefused } from "./graph.ts";
export {
  downloadWhatsAppMedia,
  fetchWhatsAppMediaMetadata,
} from "./media.ts";
export type {
  MediaDownloadOutcome,
  MediaMetadataOutcome,
  WhatsAppMediaMetadata,
} from "./media.ts";
export { fetchWhatsAppNumbers } from "./numbers.ts";
export type { NumbersFetchOutcome, WhatsAppNumberFacts } from "./numbers.ts";
export { parseWebhookPayload } from "./payload.ts";
export type {
  InboundMessage,
  NumberQualityUpdate,
  ParsedWebhook,
  SkippedChange,
  StatusUpdate,
  TemplateStatusUpdate,
} from "./payload.ts";
export {
  buildComponents,
  CATEGORY_NOTES,
  CATEGORY_RECATEGORISATION_NOTE,
  emptyDraft,
  fillVariables,
  slugifyTemplateName,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIMITS,
  templateVariables,
  validateTemplate,
} from "./template.ts";
export type {
  HeaderFormat,
  TemplateButton,
  TemplateCategory,
  TemplateComponent,
  TemplateDraft,
  TemplateIssue,
} from "./template.ts";
export {
  createWhatsAppTemplate,
  listWhatsAppTemplates,
} from "./template-graph.ts";
export type {
  MetaTemplate,
  TemplateAccepted,
  TemplateCreateOutcome,
  TemplateListOutcome,
  TemplateRefused,
} from "./template-graph.ts";
