import type { IngestSummary } from "@whatsapp-os/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the job does with what ingestion hands back.
 *
 * Ingestion itself is proved against a real database in
 * packages/db/tests/webhook-ingest.test.ts - the ordering, the idempotency and
 * the unread count are facts about constraints, and a mocked client would
 * agree with whatever the code did. What is left here is the half this process
 * owns: turning media requests into jobs, and doing it after the database work
 * rather than during it.
 */

const ingestWebhookDelivery = vi.fn<() => Promise<IngestSummary>>();

/* Typed to the shape the handler calls, so the assertions on jobId below are
   checked rather than reaching into an inferred empty tuple. */
const add = vi.fn<
  (
    name: string,
    data: Record<string, unknown>,
    options?: { jobId?: string },
  ) => Promise<{ id: string }>
>(async () => ({ id: "job-1" }));

const advanceFlow = vi.fn(async () => ({ outcome: "no_flow" }) as never);

vi.mock("@whatsapp-os/db", () => ({ ingestWebhookDelivery, advanceFlow }));
vi.mock("../src/queue.ts", () => ({ systemQueue: { add } }));

const { handleWhatsAppWebhook } = await import("../src/jobs/whatsapp-webhook.ts");

function summary(over: Partial<IngestSummary> = {}): IngestSummary {
  return {
    status: "processed",
    messages: 1,
    inserted: 1,
    statuses: 0,
    advanced: 0,
    skipped: [],
    media: [],
    flowAdvances: [],
    numberQualityUpdates: 0,
    templatesUpdated: 0,
    templatesUnmatched: 0,
    ...over,
  };
}

beforeEach(() => {
  ingestWebhookDelivery.mockReset();
  add.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a delivery with no media", () => {
  it("enqueues nothing", async () => {
    ingestWebhookDelivery.mockResolvedValue(summary());

    const result = await handleWhatsAppWebhook({
      companyId: "c1",
      eventId: "e1",
    });

    expect(add).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "processed",
      inserted: 1,
      advanced: 0,
      media: 0,
      flows: 0,
    });
  });
});

describe("a delivery carrying media", () => {
  it("enqueues one fetch per message, keyed so a repeat collapses", async () => {
    ingestWebhookDelivery.mockResolvedValue(
      summary({
        messages: 2,
        inserted: 2,
        media: [
          { messageId: "m1", metaMediaId: "meta-1" },
          { messageId: "m2", metaMediaId: "meta-2" },
        ],
      }),
    );

    await handleWhatsAppWebhook({ companyId: "c1", eventId: "e1" });

    expect(add).toHaveBeenCalledTimes(2);

    const [name, payload, options] = add.mock.calls[0]!;
    expect(name).toBe("whatsapp.media.fetch");
    expect(payload).toEqual({
      companyId: "c1",
      messageId: "m1",
      metaMediaId: "meta-1",
    });

    /*
     * Deterministic and keyed on the message: a first ingest and a redelivery
     * that found the bytes still missing produce the same id, so the file is
     * downloaded once rather than twice.
     */
    expect(options?.jobId).toBe("media:m1");
    expect(add.mock.calls[1]?.[2]?.jobId).toBe("media:m2");
  });

  it("never fetches anything itself", async () => {
    /*
     * The structural half of the rule, asserted because it is the one that
     * would be quietly undone. An inbound media message carries an id, not
     * bytes; fetching them is a Graph call, and the ingest path holds a company
     * scope while it runs - R7's pool argument, and the reason the endpoint
     * records and returns rather than processing inline.
     *
     * ingestWebhookDelivery is given no queue and makes no HTTP call, so the
     * only thing that can reach the network is this handler, after every scope
     * has closed. A fetch appearing anywhere in this path fails here.
     */
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    ingestWebhookDelivery.mockResolvedValue(
      summary({ media: [{ messageId: "m1", metaMediaId: "meta-1" }] }),
    );

    await handleWhatsAppWebhook({ companyId: "c1", eventId: "e1" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a delivery that was already processed", () => {
  it("still enqueues media the previous run never got to", async () => {
    ingestWebhookDelivery.mockResolvedValue(
      summary({
        status: "already_processed",
        inserted: 0,
        media: [{ messageId: "m1", metaMediaId: "meta-1" }],
      }),
    );

    const result = await handleWhatsAppWebhook({ companyId: "c1", eventId: "e1" });

    expect(add).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("already_processed");
    expect(result.media).toBe(1);
  });
});
