import { prisma } from "@whatsapp-os/db";
import type { PingJob } from "@whatsapp-os/core";
import { log } from "../logger.ts";

/**
 * system.ping - the one job the scaffold ships with.
 *
 * It exists to prove the whole path works end to end: a payload is enqueued by
 * the web app, validated against its shared schema, picked up by this process,
 * and able to reach Postgres. When you add the first real job, delete this one.
 */
export async function handlePing(payload: PingJob): Promise<{
  nonce: string;
  roundTripMs: number;
  dbOk: boolean;
}> {
  const enqueuedAt = new Date(payload.enqueuedAt).getTime();
  const roundTripMs = Date.now() - enqueuedAt;

  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    log.warn("ping could not reach the database", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log.info("ping handled", { nonce: payload.nonce, roundTripMs, dbOk });

  return { nonce: payload.nonce, roundTripMs, dbOk };
}
