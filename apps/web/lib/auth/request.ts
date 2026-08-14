import "server-only";
import { headers } from "next/headers";

/**
 * Client identity from request headers.
 *
 * ---------------------------------------------------------------------------
 * x-forwarded-for is attacker-controlled
 * ---------------------------------------------------------------------------
 *
 * Any client can send it. It is only meaningful when the first hop is a proxy
 * you control and that proxy *overwrites* rather than appends — otherwise a
 * request arriving with a forged header rotates its own apparent address at
 * will and walks straight through the per-IP lockout.
 *
 * The leftmost entry is used, which is the convention and is also the part an
 * untrusted client controls. That is acceptable here because the per-username
 * counter with ip='*' is the backstop that does not depend on addresses being
 * honest — it is why that second row shape exists.
 *
 * Deploying behind something that does not overwrite this header means the
 * per-IP limit is advisory. The per-username limit still holds.
 */
export async function clientIp(): Promise<string> {
  const store = await headers();

  const forwarded = store.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return store.get("x-real-ip")?.trim() || "unknown";
}

export async function clientUserAgent(): Promise<string | undefined> {
  const store = await headers();
  return store.get("user-agent") ?? undefined;
}

export async function requestContext(): Promise<{
  ip: string;
  userAgent: string | undefined;
}> {
  const [ip, userAgent] = await Promise.all([clientIp(), clientUserAgent()]);
  return { ip, userAgent };
}
