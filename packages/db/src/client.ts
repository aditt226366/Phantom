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
 * Reading DATABASE_URL at module scope looks fine and is a trap. ES module
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
  const connectionString = process.env["DATABASE_URL"];

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log:
      process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
  });
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
