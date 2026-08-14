import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * The base Prisma client.
 *
 * Prisma 7 connects through a driver adapter rather than a bundled query
 * engine, so the Postgres pool is constructed here and handed to the client.
 *
 * ---------------------------------------------------------------------------
 * Why this is lazy
 * ---------------------------------------------------------------------------
 * Reading DATABASE_URL_APP at module scope looks fine and is a trap. ES module
 * imports are evaluated in import order, before any statement in the importing
 * module runs - so in the worker:
 *
 *     import { prisma } from "@whatsapp-os/db";   // <- evaluated first
 *     import { env } from "./env.ts";             // <- loads .env, too late
 *
 * the client would capture an empty connection string and every query would
 * fail with "client password must be a string". Reordering imports would fix
 * it today and break again the moment someone sorts them.
 *
 * Instead the client is built on first *use*, behind a Proxy. By then dotenv
 * has run, whatever the import order. It also means `next build` can import a
 * route module without a database being configured at all.
 *
 * The singleton is cached on globalThis outside production because Next.js hot
 * reload re-evaluates modules on every edit, and a fresh connection pool per
 * edit exhausts Postgres within minutes.
 */

function createPrismaClient() {
  const connectionString = process.env["DATABASE_URL_APP"];

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_APP is not set. Copy .env.example to .env and fill it in, " +
        "then run `npm run db:roles`.\n\n" +
        "This is deliberately NOT falling back to DATABASE_URL. That variable " +
        "holds the table owner, and Postgres exempts a table's owner from its " +
        "own row-level security policies — connecting with it at runtime would " +
        "disable tenant isolation everywhere, silently.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: Number(process.env["DATABASE_POOL_MAX"] ?? 10),
    }),
    log:
      process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
  });
}

/**
 * Fail loudly if the runtime connection has RLS-exempt privileges.
 *
 * The worst possible misconfiguration in this system is pointing
 * DATABASE_URL_APP at a superuser or the table owner: everything keeps working,
 * every test still passes, and tenant isolation is silently gone. One query at
 * startup is a cheap price for making that impossible to ship.
 */
export async function assertRuntimeRoleIsUnprivileged(): Promise<void> {
  const [role] = await getPrismaClient().$queryRaw<
    Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>
  >`
    SELECT current_user, rolsuper, rolbypassrls
    FROM pg_roles WHERE rolname = current_user
  `;

  if (!role) {
    throw new Error("Could not determine the current database role.");
  }

  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `DATABASE_URL_APP connects as "${role.current_user}", which is ` +
        `${role.rolsuper ? "a superuser" : "BYPASSRLS"}. Row-level security ` +
        "does not apply to it, so tenant isolation is not enforced. Point " +
        "DATABASE_URL_APP at app_runtime (`npm run db:roles`).",
    );
  }
}

type PrismaClientSingleton = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  __whatsappOsPrisma?: PrismaClientSingleton;
};

let instance: PrismaClientSingleton | undefined;

/** Resolve the singleton, constructing it on first call. */
export function getPrismaClient(): PrismaClientSingleton {
  if (instance) return instance;

  instance = globalForPrisma.__whatsappOsPrisma ?? createPrismaClient();

  if (process.env["NODE_ENV"] !== "production") {
    globalForPrisma.__whatsappOsPrisma = instance;
  }

  return instance;
}

/**
 * The client, as a normal object.
 *
 * The Proxy forwards every property access to the real client, constructing it
 * on the first one. Methods are bound so `prisma.$queryRaw` keeps its `this`
 * when destructured.
 */
export const prisma: PrismaClientSingleton = new Proxy(
  {} as PrismaClientSingleton,
  {
    get(_target, property) {
      const client = getPrismaClient();
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
    has(_target, property) {
      return property in getPrismaClient();
    },
  },
);

/** Cheap liveness probe used by /api/health. Never throws. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
