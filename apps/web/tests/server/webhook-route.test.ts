import { createHmac } from "node:crypto";
import { PROTECTED_PREFIXES } from "@/lib/nav";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The endpoint Meta posts to.
 *
 * The pieces underneath are proved elsewhere - the signature in core, the
 * delivery record and the unroutable upsert in packages/db, the cache and the
 * throttle in their own suites here. What this asserts is the route's own
 * contract, which is almost entirely about status codes and ordering:
 *
 *   what returns 200, and why nearly everything does
 *   that the throttle is consulted before anything expensive
 *   that a delivery which fails to record still answers 200 (R7)
 *   that the challenge is echoed as raw text
 */

const getWebhookSecrets = vi.fn();
const recordWebhookDelivery = vi.fn();
/* Typed to the shapes the route calls, so the argument assertions below are
   checked rather than reaching into an inferred empty tuple. */
const recordUnroutableWebhook =
  vi.fn<
    (input: {
      webhookKeyHash: string;
      reason: string;
      companyId?: string;
      ipHash?: string;
    }) => Promise<void>
  >();
const checkWebhookAllowed =
  vi.fn<(ipHash: string) => Promise<{ locked: boolean; until?: Date }>>();
const recordWebhookFailure = vi.fn(async () => undefined);
const clearWebhookFailures = vi.fn(async () => undefined);
const add =
  vi.fn<
    (
      name: string,
      data: Record<string, unknown>,
      options?: { jobId?: string },
    ) => Promise<{ id: string }>
  >();

/** The order the interesting steps ran in. */
const sequence: string[] = [];

vi.mock("@whatsapp-os/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/db")>()),
  withCompany: async (_companyId: string, callback: (db: unknown, id: string) => unknown) =>
    callback({}, _companyId),
  recordWebhookDelivery: (...args: unknown[]) => {
    sequence.push("record");
    return recordWebhookDelivery(...args);
  },
  recordUnroutableWebhook,
}));

vi.mock("@/lib/webhook-secrets", () => ({
  getWebhookSecrets: (key: string) => {
    sequence.push("resolve");
    return getWebhookSecrets(key);
  },
}));

vi.mock("@/lib/auth/lockout", () => ({
  checkWebhookAllowed: (hash: string) => {
    sequence.push("throttle");
    return checkWebhookAllowed(hash);
  },
  recordWebhookFailure,
  clearWebhookFailures,
}));

vi.mock("@/lib/queue", () => ({ systemQueue: { add } }));

vi.mock("@/lib/auth/request", () => ({ clientIp: async () => "203.0.113.9" }));

const { GET, POST } = await import("@/app/api/webhooks/whatsapp/[key]/route");

const APP_SECRET = "app-secret-value";
const VERIFY_TOKEN = "verify-token-value";

function secrets() {
  return {
    companyId: "company-1",
    integrationId: "int-1",
    appSecret: { reveal: () => APP_SECRET },
    verifyToken: { reveal: () => VERIFY_TOKEN },
  };
}

const ctx = { params: Promise.resolve({ key: "abc123" }) };

function signed(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/webhooks/whatsapp/abc123", {
    method: "POST",
    body,
    headers,
  });
}

const DELIVERY = { eventId: "evt-1", enqueue: true, redelivery: false, deliveryCount: 1 };

beforeEach(() => {
  for (const mock of [
    getWebhookSecrets,
    recordWebhookDelivery,
    recordUnroutableWebhook,
    checkWebhookAllowed,
    recordWebhookFailure,
    clearWebhookFailures,
    add,
  ]) {
    mock.mockReset();
  }

  sequence.length = 0;

  getWebhookSecrets.mockResolvedValue(secrets());
  recordWebhookDelivery.mockResolvedValue(DELIVERY);
  recordUnroutableWebhook.mockResolvedValue(undefined);
  checkWebhookAllowed.mockResolvedValue({ locked: false });
  recordWebhookFailure.mockResolvedValue(undefined);
  clearWebhookFailures.mockResolvedValue(undefined);
  add.mockResolvedValue({ id: "job-1" });
});

describe("the handshake", () => {
  it("echoes the challenge as raw text, not JSON", async () => {
    const url =
      "https://example.test/api/webhooks/whatsapp/abc123" +
      `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`;

    const response = await GET(new Request(url), ctx);

    expect(response.status).toBe(200);

    /*
     * Byte for byte. Response.json would send "1158201444" with quotes, Meta
     * would compare it against 1158201444 and refuse the subscription - and say
     * nothing about encoding while doing it.
     */
    expect(await response.text()).toBe("1158201444");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a wrong verify token", async () => {
    const url =
      "https://example.test/api/webhooks/whatsapp/abc123" +
      "?hub.mode=subscribe&hub.verify_token=not-it&hub.challenge=123";

    const response = await GET(new Request(url), ctx);

    /*
     * 403 rather than the 200 everything else gets, and deliberately: a
     * handshake is a person waiting for an answer, with no subscription yet to
     * protect. Answering 200 without the challenge would let them believe it
     * worked.
     */
    expect(response.status).toBe(403);
  });

  it("refuses a key that resolves to nothing", async () => {
    getWebhookSecrets.mockResolvedValue(null);

    const url =
      "https://example.test/api/webhooks/whatsapp/abc123" +
      `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`;

    expect((await GET(new Request(url), ctx)).status).toBe(403);
  });
});

describe("a genuine delivery", () => {
  it("records it and enqueues the work", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const response = await POST(
      post(body, { "x-hub-signature-256": signed(body) }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(recordWebhookDelivery).toHaveBeenCalledTimes(1);

    /* The stored payload is the exact bytes, because the digest was computed
       over them and jsonb would reorder the keys. */
    expect(recordWebhookDelivery.mock.calls[0]![2]).toMatchObject({ payload: body });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![2]).toMatchObject({ jobId: "webhook:evt-1:1" });
  });

  it("clears the address's failures, so a stale secret recovers by itself", async () => {
    const body = "{}";
    await POST(post(body, { "x-hub-signature-256": signed(body) }), ctx);

    expect(clearWebhookFailures).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue a delivery that was already processed", async () => {
    recordWebhookDelivery.mockResolvedValue({ ...DELIVERY, enqueue: false });

    const body = "{}";
    await POST(post(body, { "x-hub-signature-256": signed(body) }), ctx);

    expect(add).not.toHaveBeenCalled();
  });

  it("still answers 200 when the event row cannot be written", async () => {
    recordWebhookDelivery.mockRejectedValue(new Error("pool timeout"));

    const body = "{}";
    const response = await POST(
      post(body, { "x-hub-signature-256": signed(body) }),
      ctx,
    );

    /*
     * R7, and the one deliberate exception to "never 200 what we cannot keep".
     * The event row is fast-path dedupe and forensics; the correctness
     * guarantee is the (company_id, wamid) unique the worker enforces. A
     * non-2xx here would count toward the subscription being disabled during
     * exactly the burst that caused the timeout.
     */
    expect(response.status).toBe(200);
  });
});

describe("a delivery that is not Meta's", () => {
  it("answers 200 and records an unknown key", async () => {
    getWebhookSecrets.mockResolvedValue(null);

    const response = await POST(post("{}"), ctx);

    /* Never 404. A rotated key or stale Meta config would otherwise burn
       toward the same disablement everything here is arranged to avoid. */
    expect(response.status).toBe(200);
    expect(recordUnroutableWebhook.mock.calls[0]![0]).toMatchObject({
      reason: "UNKNOWN_KEY",
    });
    expect(recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("never stores the body of an unknown delivery", async () => {
    getWebhookSecrets.mockResolvedValue(null);

    await POST(post('{"secret":"attacker-supplied"}'), ctx);

    /* The endpoint is unauthenticated, so keeping payloads is a stuffing
       vector. Only a hash of the key, the reason and a hashed address. */
    const recorded = JSON.stringify(recordUnroutableWebhook.mock.calls[0]![0]);
    expect(recorded).not.toContain("attacker-supplied");
  });

  it("answers 200 and records a bad signature", async () => {
    const body = "{}";
    const response = await POST(
      post(body, { "x-hub-signature-256": signed(body, "the-wrong-secret") }),
      ctx,
    );

    /*
     * P5. This is also what genuine Meta traffic looks like when our stored app
     * secret is stale, which is why it is recorded and throttled but not
     * refused.
     */
    expect(response.status).toBe(200);
    expect(recordUnroutableWebhook.mock.calls[0]![0]).toMatchObject({
      reason: "BAD_SIGNATURE",
      companyId: "company-1",
    });
    expect(recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("ignores the legacy sha1 header entirely", async () => {
    const body = "{}";
    const sha1 = `sha1=${createHmac("sha1", APP_SECRET).update(body).digest("hex")}`;

    const response = await POST(post(body, { "x-hub-signature": sha1 }), ctx);

    /* Accepting it as a fallback would let a downgrade past the check this
       exists to be. */
    expect(response.status).toBe(200);
    expect(recordWebhookDelivery).not.toHaveBeenCalled();
  });

  it("answers 200 with no body at all", async () => {
    const response = await POST(post("{}"), ctx);

    expect(response.status).toBe(200);
    expect(recordWebhookDelivery).not.toHaveBeenCalled();
  });
});

describe("a throttled address", () => {
  it("is checked before anything expensive happens", async () => {
    const body = "{}";
    await POST(post(body, { "x-hub-signature-256": signed(body) }), ctx);

    /*
     * The throttle runs before the resolve, so a flood costs one indexed
     * lookup rather than a resolve, a transaction and two decrypts.
     */
    expect(sequence).toEqual(["throttle", "resolve", "record"]);
  });

  it("does no work and answers 200", async () => {
    checkWebhookAllowed.mockResolvedValue({ locked: true, until: new Date() });

    const body = "{}";
    const response = await POST(
      post(body, { "x-hub-signature-256": signed(body) }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(getWebhookSecrets).not.toHaveBeenCalled();
    expect(recordWebhookDelivery).not.toHaveBeenCalled();
  });
});

describe("reachability", () => {
  it("is not behind the session guard", () => {
    /*
     * isProtected() is false for /api/*, so this holds today. It is asserted
     * because the failure mode is silence: a matcher change that swept the
     * webhook into the protected set would answer Meta with a 307 to /sign-in,
     * Meta would count it as a failure, and the first symptom would be messages
     * quietly not arriving - about a week before the subscription is disabled.
     */
    const path = "/api/webhooks/whatsapp/abc123";

    const guarded = PROTECTED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );

    expect(guarded, "the webhook route is behind the session guard").toBe(false);
  });
});
