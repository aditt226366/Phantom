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

/** Model types and the Prisma namespace, re-exported so apps import one package. */
export { Prisma } from "./generated/prisma/client.ts";
export type {
  Company,
  User,
  Session,
  EmailVerificationToken,
  AuditLog,
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
} from "./generated/prisma/enums.ts";
