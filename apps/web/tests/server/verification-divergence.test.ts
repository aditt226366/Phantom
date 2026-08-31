import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Both verification paths must produce the same side effects.
 *
 * There are two, and they share no code: the admin panel verifies INLINE in a
 * server action, and the repair fan-out enqueues an integration.verify job the
 * worker runs. Commit 21 added "enqueue a numbers refresh after a successful
 * verification" to the worker one only.
 *
 * That was invisible in every way a bug can be. The panel reported success. No
 * log line, no failed job, no error. whatsapp_numbers simply stayed empty, and
 * every inbound message was skipped with unknown_phone_number_id - three layers
 * away from the cause.
 *
 * This is deliberately NOT "does the admin path enqueue a refresh". That test
 * would be written against the fix and would prove only what was just typed.
 * This drives BOTH paths and compares what each one did, as a set, so the
 * assertion holds for the effect nobody has thought of yet - and fails when a
 * third path appears that forgets one.
 */

/* What each path enqueued, by job name. The observable both share. */
const enqueued: { web: string[]; worker: string[] } = { web: [], worker: [] };
let recording: "web" | "worker" = "web";

const add = vi.fn(async (name: string) => {
  enqueued[recording].push(name);
  return { id: "job-1" };
});

/* ---------------------------------------------------------------- web --- */

vi.mock("@/lib/queue", () => ({ systemQueue: { add } }));

const verifyIntegration = vi.fn();
vi.mock("@/lib/integrations/verify", () => ({
  verifyIntegration: (...args: unknown[]) => verifyIntegration(...args),
}));

vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => ({
    sessionId: "s1",
    adminUserId: "admin-1",
    username: "root",
    csrfSecret: "secret",
  }),
  assertAdminCsrf: async () => undefined,
}));

vi.mock("@/lib/admin-db", () => ({
  writeAdminAudit: async () => undefined,
}));

/* requestContext reaches next/headers, which needs a live request scope. */
vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: "203.0.113.9", userAgent: "test" }),
  clientIp: async () => "203.0.113.9",
  clientUserAgent: async () => "test",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));

/* ------------------------------------------------------------- worker --- */

vi.mock("../../../worker/src/queue.ts", () => ({ systemQueue: { add } }));
vi.mock("../../../worker/src/keyring.ts", () => ({ keyring: () => ({}) }));
vi.mock("../../../worker/src/logger.ts", () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

const findManyIntegrations = vi.fn();
vi.mock("@whatsapp-os/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/db")>()),
  withCompany: async (companyId: string, cb: (db: unknown, id: string) => unknown) =>
    cb(
      {
        integration: { findMany: findManyIntegrations, update: async () => ({}) },
        integrationVerification: { create: async () => ({}) },
      },
      companyId,
    ),
  recordUsage: async () => ({}),
}));

/* verifierFor is what the worker calls to reach the provider. Stubbed so both
   paths are verifying the same imaginary integration, successfully. */
vi.mock("@whatsapp-os/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-os/core")>()),
  decrypt: () => "plain",
  secretAad: () => "aad",
  verifierFor: () => async () => ({ ok: true, statusCode: 200 }),
}));

const { testIntegrationAction } = await import("@/app/(admin)/admin/actions");
const { handleIntegrationVerify } = await import(
  "../../../worker/src/jobs/integration-verify.ts"
);

const COMPANY = "company-1";

function formData(): FormData {
  const fd = new FormData();
  fd.set("companyId", COMPANY);
  fd.set("provider", "WHATSAPP_CLOUD");
  return fd;
}

beforeEach(() => {
  enqueued.web = [];
  enqueued.worker = [];
  add.mockClear();
  verifyIntegration.mockReset();
  findManyIntegrations.mockReset();

  verifyIntegration.mockResolvedValue({
    integrationId: "int-1",
    ok: true,
    statusCode: 200,
  });

  findManyIntegrations.mockResolvedValue([
    {
      id: "int-1",
      provider: "WHATSAPP_CLOUD",
      secrets: [{ key: "WHATSAPP_ACCESS_TOKEN", ciphertext: "ct" }],
    },
  ]);
});

async function runWeb(): Promise<string[]> {
  recording = "web";
  await testIntegrationAction({}, formData());
  return enqueued.web;
}

async function runWorker(): Promise<string[]> {
  recording = "worker";
  await handleIntegrationVerify({ companyId: COMPANY }, "verify-job-1");
  return enqueued.worker;
}

describe("a verification that succeeds", () => {
  it("produces the same effects whichever path ran it", async () => {
    const web = new Set(await runWeb());
    const worker = new Set(await runWorker());

    /*
     * The assertion this file exists for. Not a named effect - a comparison -
     * so it keeps holding when the set grows, and fails the moment one path
     * gains something the other does not.
     */
    expect(web, "the two verification paths have diverged").toEqual(worker);

    /* And non-empty, so two paths that both do nothing cannot pass. */
    expect(web.size).toBeGreaterThan(0);
  });

  it("refreshes the numbers, which is what the divergence cost", async () => {
    /*
     * Named once, as the regression this actually was: whatsapp_numbers stayed
     * empty, so every inbound message was skipped as unknown_phone_number_id.
     */
    expect(await runWeb()).toContain("whatsapp.numbers.refresh");
    expect(await runWorker()).toContain("whatsapp.numbers.refresh");
  });
});

describe("a verification that fails", () => {
  it("produces the same effects - none - whichever path ran it", async () => {
    verifyIntegration.mockResolvedValue({
      integrationId: "int-1",
      ok: false,
      kind: "auth",
      error: "Invalid OAuth token",
    });
    findManyIntegrations.mockResolvedValue([]);

    const web = new Set(await runWeb());
    const worker = new Set(await runWorker());

    /* The negative case matters as much: an effect that fires on failure in one
       path and not the other is the same class of divergence. */
    expect(web).toEqual(worker);
    expect(web.size).toBe(0);
  });
});
