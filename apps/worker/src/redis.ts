import Redis from "ioredis";
import { env } from "./env.ts";

/**
 * Redis connection for the worker.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands
 * (BRPOPLPUSH and friends) sit open for a long time, and ioredis's default
 * retry cap would abort them. This is the one place that setting is correct -
 * the web side deliberately uses a bounded retry instead.
 */
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

connection.on("error", (error: Error) => {
  console.error("[redis] connection error:", error.message);
});
