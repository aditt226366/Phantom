export {
  prisma,
  checkDatabase,
  assertRuntimeRoleIsUnprivileged,
} from "./client.ts";
export { withCompany, COMPANY_SCOPED_MODELS } from "./with-company.ts";
export type { CompanyClient } from "./with-company.ts";

/** Model types and the Prisma namespace, re-exported so apps import one package. */
export { Prisma } from "./generated/prisma/client.ts";
export type { Company, User } from "./generated/prisma/client.ts";
