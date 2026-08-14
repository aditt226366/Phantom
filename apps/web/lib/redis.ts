import Redis from "ioredis";

/**
 * Redis connection for the web process.
 *
 * The web side is a queue *producer* and a health checker - it never runs a
 * BullMQ Worker - so the connection is configured to fail fast rather than
 * retry forever. A hanging health check is worse than a failing one.
 *
 * Cached on globalThis for the same hot-reload reason as the Prisma client.
 */

const globalForRedis = globalThis as unknown as {
  __whatsappOsRedis?: Redis;
};

function createRedis(): Redis {
  const client = new Redis(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379", {
    /* BullMQ requires null on connections used by a Worker. This one only
       produces and pings, so a bounded retry is the better trade. */
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: 3_000,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  });

  /* An unhandled 'error' event on an ioredis client crashes the process.
     Swallow it here; callers surface failure through their own return value. */
  client.on("error", () => {});

  return client;
}

export const redis: Redis = globalForRedis.__whatsappOsRedis ?? createRedis();

if (process.env["NODE_ENV"] !== "production") {
  globalForRedis.__whatsappOsRedis = redis;
}

/** Cheap liveness probe used by /api/health. Never throws. */
export async function checkRedis(): Promise<boolean> {
  try {
    if (redis.status === "wait" || redis.status === "end") {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
