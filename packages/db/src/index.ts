export { prisma, checkDatabase } from "./client.ts";
export { withTenant, TENANT_SCOPED_MODELS } from "./with-tenant.ts";
export type { TenantClient } from "./with-tenant.ts";

/** Model types and the Prisma namespace, re-exported so apps import one package. */
export { Prisma } from "./generated/prisma/client.ts";
export type { Tenant, User } from "./generated/prisma/client.ts";
