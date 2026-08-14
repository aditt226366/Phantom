import { checkDatabase } from "@whatsapp-os/db";
import { healthResponseSchema, type HealthResponse } from "@whatsapp-os/core";
import { checkRedis } from "@/lib/redis";

/**
 * GET /api/health -> { ok, db, redis }
 *
 * `ok` is true only when both dependencies answer. The route always returns a
 * body - a health check that 500s with an HTML error page tells a load
 * balancer far less than one that reports which dependency is down.
 *
 * Status code is 200 when healthy, 503 when not, so orchestrators can read it
 * without parsing JSON.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  const body: HealthResponse = healthResponseSchema.parse({
    ok: db && redis,
    db,
    redis,
  });

  return Response.json(body, {
    status: body.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
