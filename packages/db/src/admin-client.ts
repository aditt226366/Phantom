import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * The platform-admin client. Reads across every company.
 *
 * ---------------------------------------------------------------------------
 * THIS BYPASSES TENANT ISOLATION. That is its whole purpose.
 * ---------------------------------------------------------------------------
 *
 * It connects as app_admin, which the RLS migration gives an unconditional
 * permissive policy on every tenant table. Nothing here is scoped to a company
 * and nothing here should ever be reachable from a tenant session.
 *
 * It is exported from the "@whatsapp-os/db/admin" subpath and deliberately NOT
 * from the package index, so that:
 *   - importing it is a distinct, greppable specifier;
 *   - an ESLint no-restricted-imports rule can ban it everywhere except the
 *     one module that is allowed to use it (apps/web/lib/admin-db.ts).
 *
 * If you are reaching for this from a route handler or a server action, you
 * want withCompany instead.
 */

function createAdminClient() {
  const connectionString = process.env["DATABASE_URL_ADMIN"];

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_ADMIN is not set, so the platform admin client is " +
        "unavailable. Add it to .env and run `npm run db:roles`.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 4 }),
    log: ["error"],
  });
}

type AdminClientSingleton = ReturnType<typeof createAdminClient>;

const globalForAdmin = globalThis as unknown as {
  __whatsappOsAdminPrisma?: AdminClientSingleton;
};

let instance: AdminClientSingleton | undefined;

function getAdminClient(): AdminClientSingleton {
  if (instance) return instance;

  instance = globalForAdmin.__whatsappOsAdminPrisma ?? createAdminClient();

  if (process.env["NODE_ENV"] !== "production") {
    globalForAdmin.__whatsappOsAdminPrisma = instance;
  }

  return instance;
}

/** Lazy for the same reason as the runtime client — see client.ts. */
export const adminPrisma: AdminClientSingleton = new Proxy(
  {} as AdminClientSingleton,
  {
    get(_target, property) {
      const client = getAdminClient();
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
    has(_target, property) {
      return property in getAdminClient();
    },
  },
);
