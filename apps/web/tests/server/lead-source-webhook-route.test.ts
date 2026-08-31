import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The doorbell a tenant's Apps Script rings.
 *
 * The pieces underneath are proved elsewhere - the resolver branch in
 * packages/db, the poll itself in the worker suite. What this asserts is the
 * route's own contract, which is almost entirely about what it refuses to do:
 *
 *   the company id comes from the resolver and never from the request
 *   an unknown key and a suspended workspace answer identically
 *   the throttle is consulted before the resolver
 *   a paused binding enqueues nothing
 *   a burst of edits collapses to one poll per second
 */

const resolveCompany = vi.fn<(kind: string, key: string) => Promise<string | null>>();
const findFirst =
  vi.fn<
    (args: { where: Record<string, unknown> }) => Promise<{ id: string } | null>
  >();
const checkWebhookAllowed =
  vi.fn<(ipHash: string) => Promise<{ locked: boolean }>>();
const recordWebhookFailure = vi.fn(async () => undefined);
const clearWebhookFailures = vi.fn(async () => undefined);
const add =
  vi.fn<
    (
      name: string,
      data: Record<string, unknown>,
      options?: { jobId?: string },
    ) => Promise<unknown>
  >();

/** The order the interesting steps ran in. */
const sequence: string[] = [];

vi.mock("@whatsapp-os/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/db")>()),
  resolveCompany: (kind: string, key: string) => {
    sequence.push("resolve");
    return resolveCompany(kind, key);
  },
  withCompany: async (
    companyId: string,
    callback: (db: unknown, id: string) => unknown,
  ) => callback({ leadSource: { findFirst } }, companyId),
}));

vi.mock("@/lib/auth/request", () => ({ clientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/auth/ip-hash", () => ({ hashIp: (ip: string) => `hash:${ip}` }));

vi.mock("@/lib/auth/lockout", () => ({
  checkWebhookAllowed: (ipHash: string) => {
    sequence.push("throttle");
    return checkWebhookAllowed(ipHash);
  },
  recordWebhookFailure: () => recordWebhookFailure(),
  clearWebhookFailures: () => clearWebhookFailures(),
}));

vi.mock("@/lib/queue", () => ({
  systemQueue: {
    add: (
      name: string,
      data: Record<string, unknown>,
      options?: { jobId?: string },
    ) => {
      sequence.push("enqueue");
      return add(name, data, options);
    },
  },
}));

const { POST } = await import("@/app/api/webhooks/lead-source/[key]/route");

function ping(key: string): Promise<Response> {
  return POST(new Request("https://example.test/api/webhooks/lead-source/x", {
    method: "POST",
  }), { params: Promise.resolve({ key }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  sequence.length = 0;
  checkWebhookAllowed.mockResolvedValue({ locked: false });
  resolveCompany.mockResolvedValue("company-1");
  findFirst.mockResolvedValue({ id: "binding-1" });
  add.mockResolvedValue(undefined);
});

describe("a valid ping", () => {
  it("enqueues a poll for the company the RESOLVER named", async () => {
    /*
     * The whole security property. Nothing in the request reaches withCompany -
     * the id comes from app_resolve_company, which derives it from a key the
     * caller already possessed. A company id taken from the path or the body
     * would be a total bypass of every policy in the schema.
     */
    const response = await ping("real-key");

    expect(response.status).toBe(200);
    expect(resolveCompany).toHaveBeenCalledWith("lead_source", "real-key");
    expect(add.mock.calls[0]![1]).toEqual({
      companyId: "company-1",
      leadSourceId: "binding-1",
    });
  });

  it("looks the binding up inside the resolved company's scope", async () => {
    await ping("real-key");

    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      webhookKey: "real-key",
      companyId: "company-1",
      status: "ACTIVE",
    });
  });

  it("collapses a burst of edits to one poll per second", async () => {
    /*
     * A spreadsheet being edited by four people fires onChange continuously.
     * Without the job id every change would be its own read - a wasted call
     * against a quota Google meters per PROJECT, so one tenant's busy sheet
     * would exhaust every other tenant's allowance.
     */
    await ping("real-key");
    await ping("real-key");

    const [first, second] = add.mock.calls;

    expect(first![2]?.jobId).toBe(second![2]?.jobId);
    expect(first![2]?.jobId).toMatch(/^lead-poll:binding-1:\d+$/);
  });

  it("clears the throttle's memory of this caller", async () => {
    await ping("real-key");

    expect(clearWebhookFailures).toHaveBeenCalled();
  });
});

describe("what it refuses", () => {
  it("answers 404 for a key nobody holds", async () => {
    resolveCompany.mockResolvedValue(null);

    const response = await ping("nonsense");

    expect(response.status).toBe(404);
    expect(add).not.toHaveBeenCalled();
  });

  it("answers a suspended workspace exactly as it answers a bad key", async () => {
    /*
     * The resolver refuses both by returning null, and the route cannot tell
     * them apart - which is the point. Distinguishing them would tell an
     * unauthenticated caller which keys are real, the one piece of information
     * this endpoint has to give away.
     */
    resolveCompany.mockResolvedValue(null);

    const suspended = await ping("real-key-for-suspended-company");
    const unknown = await ping("nonsense");

    expect(suspended.status).toBe(unknown.status);
    expect(await suspended.text()).toBe(await unknown.text());
  });

  it("records a failure so the keyspace cannot be walked for free", async () => {
    resolveCompany.mockResolvedValue(null);

    await ping("nonsense");

    expect(recordWebhookFailure).toHaveBeenCalled();
  });

  it("checks the throttle before it does anything expensive", async () => {
    /* An unauthenticated endpoint whose path segment is the only credential.
       Without this, a million wrong keys cost a million resolver lookups. */
    checkWebhookAllowed.mockResolvedValue({ locked: true });

    const response = await ping("real-key");

    expect(response.status).toBe(429);
    expect(sequence).toEqual(["throttle"]);
    expect(resolveCompany).not.toHaveBeenCalled();
  });

  it("enqueues nothing for a paused binding, and does not call it an error", async () => {
    /*
     * The key is real, so nothing is wrong with the request - the tenant
     * pressed Pause. Their script should not start reporting failures because
     * of a decision they made here, and we should not run a job per edit for a
     * binding that will decline every one.
     */
    findFirst.mockResolvedValue(null);

    const response = await ping("real-key");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, polled: false });
    expect(add).not.toHaveBeenCalled();
  });

  it("never reads the request body", async () => {
    /*
     * Not "the body is validated" - it is never looked at. The poll reads the
     * spreadsheet through the tenant's own credential with the same cleaning
     * and the same unique index as every scheduled poll, so there is no shape a
     * request could take that puts a lead into the system.
     *
     * Asserted by handing it a body that would throw if anything touched it.
     */
    const exploding = new Request("https://example.test/x", {
      method: "POST",
      body: "{}",
    });

    Object.defineProperty(exploding, "json", {
      value: () => {
        throw new Error("the route read the body");
      },
    });
    Object.defineProperty(exploding, "text", {
      value: () => {
        throw new Error("the route read the body");
      },
    });

    const response = await POST(exploding, {
      params: Promise.resolve({ key: "real-key" }),
    });

    expect(response.status).toBe(200);
  });
});
