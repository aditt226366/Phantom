export {
  prisma,
  checkDatabase,
  assertRuntimeRoleIsUnprivileged,
} from "./client.ts";
export {
  withCompany,
  newCompanyId,
  COMPANY_SCOPED_MODELS,
} from "./with-company.ts";
export type { CompanyClient, WithCompanyOptions } from "./with-company.ts";
export { resolveCompany } from "./resolve-company.ts";
export type { ResolveKind } from "./resolve-company.ts";
export { createCompany, slugify } from "./company.ts";
export { recordUsage } from "./usage.ts";
export { mediaStore, MediaTruncatedError } from "./media-store.ts";
export {
  recordWebhookDelivery,
  markWebhookProcessed,
  countUnprocessedWebhooks,
  MAX_WEBHOOK_PAYLOAD_BYTES,
} from "./webhook-events.ts";
export type {
  WebhookDelivery,
  WebhookDeliveryInput,
  WebhookOutcome,
} from "./webhook-events.ts";
export {
  canSend,
  advanceConversation,
  applyStatusUpdate,
  readReceiptTarget,
  markConversationRead,
} from "./conversations.ts";
export type {
  Sendability,
  ConversationActivity,
  ReadReceiptTarget,
  StatusOutcome,
  StatusUpdateInput,
} from "./conversations.ts";
export {
  recordSendAccepted,
  recordSendRefused,
  recordSendUnconfirmed,
  recordSendDeclined,
  describeRefusal,
  DELIVERY_UNKNOWN_TITLE,
} from "./send.ts";
export type { SendAcceptance } from "./send.ts";
export { applyNumberRefresh, MISSING_FROM_META_LIST } from "./numbers.ts";
export {
  applyTemplateStatus,
  recordTemplateEdit,
  TEMPLATE_EDIT_LIMIT,
  TEMPLATE_EDIT_WINDOW_DAYS,
  templateEditQuota,
} from "./templates.ts";
export type { TemplateEditQuota } from "./templates.ts";
export type { NumberRefreshCounts } from "./numbers.ts";
export { ingestWebhookDelivery } from "./webhook-ingest.ts";
export type { IngestSummary, MediaFetchRequest } from "./webhook-ingest.ts";
export { recordUnroutableWebhook } from "./unroutable-webhooks.ts";
export type {
  UnroutableWebhookInput,
  UnroutableReasonName,
} from "./unroutable-webhooks.ts";
export type {
  MediaStore,
  MediaStat,
  MediaPut,
  MediaStateName,
} from "./media-store.ts";
export {
  currentKycDocuments,
  currentKycStatuses,
  listKycDocuments,
  statKycDocument,
  putKycDocument,
  readKycDocument,
  KycDocumentTruncatedError,
  KYC_KINDS,
  MAX_KYC_DOCUMENT_BYTES,
} from "./kyc.ts";
export type {
  KycKind,
  KycDocumentStat,
  CurrentKycDocuments,
  KycDocumentUpload,
} from "./kyc.ts";
export { resealCompanySecrets } from "./vault.ts";
export type { ResealCounts, ResealFailure } from "./vault.ts";
export type { RecordUsageInput, RecordedUsage } from "./usage.ts";

/** Model types and the Prisma namespace, re-exported so apps import one package. */
export { Prisma } from "./generated/prisma/client.ts";
export type {
  Company,
  User,
  Session,
  EmailVerificationToken,
  AuditLog,
  Integration,
  IntegrationSecret,
  IntegrationVerification,
  UsageEvent,
  WhatsAppNumber,
  Contact,
  Conversation,
  Message,
  WhatsAppMedia,
  WhatsAppWebhookEvent,
  UnroutableWebhook,
  KycDocument,
  Broadcast,
  BroadcastRecipient,
  LoginAttempt,
  AdminUser,
  AdminSession,
  AdminAuditLog,
} from "./generated/prisma/client.ts";
export {
  UserRole,
  AuditAction,
  LoginScope,
  Plan,
  IntegrationProvider,
  IntegrationStatus,
  WhatsAppQualityRating,
  MessageDirection,
  MessageStatus,
  MessageFailureSource,
  ConversationSource,
  MediaState,
  UnroutableReason,
  KycDocumentKind,
  KycDocumentStatus,
  BroadcastStatus,
  BroadcastRecipientState,
} from "./generated/prisma/enums.ts";
