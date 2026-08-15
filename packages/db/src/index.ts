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
export type {
  MediaStore,
  MediaStat,
  MediaPut,
  MediaStateName,
} from "./media-store.ts";
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
  WhatsAppNumberStatus,
  WhatsAppQualityRating,
  MessageDirection,
  MessageStatus,
  MessageFailureSource,
  ConversationSource,
  MediaState,
} from "./generated/prisma/enums.ts";
