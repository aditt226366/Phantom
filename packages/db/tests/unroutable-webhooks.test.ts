import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordUnroutableWebhook } from "../src/index.ts";
import {
  rawRuntimeClient,
  seedCompany,
  superuserClient,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * A global table written by an unauthenticated endpoint.
 *
 * Two things need proving: that a flood against one URL stays one row, and that
 * the tenant runtime cannot read it. The bound against a flood across many URLs
 * is the per-address throttle, which lives in the web layer - what is testable
 * here is that this table does not pretend to provide it.
 */

let su: pg.Pool;
let alpha: SeededCompany;

beforeAll(() => {
  su = superuserClient();
});

afterAll(async () => {
  await su.end();
});

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
});

async function rows() {
  const { rows: found } = await su.query(
    `SELECT webhook_key_hash, reason, company_id, attempt_count, last_ip_hash,
            first_seen_at, last_seen_at
       FROM unroutable_webhooks ORDER BY webhook_key_hash`,
  );
  return found;
}

describe("recording", () => {
  it("writes one row for an unknown key", async () => {
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-unknown",
      reason: "UNKNOWN_KEY",
      ipHash: "ip-1",
    });

    expect(await rows()).toMatchObject([
      {
        webhook_key_hash: "hash-unknown",
        reason: "UNKNOWN_KEY",
        company_id: null,
        attempt_count: 1,
      },
    ]);
  });

  it("names the company when the key resolved but the signature did not", async () => {
    /*
     * The operator question is "whose deliveries are failing", and it is only
     * answerable if the row says. Null for UNKNOWN_KEY because there genuinely
     * is no company.
     */
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-badsig",
      reason: "BAD_SIGNATURE",
      companyId: alpha.id,
      ipHash: "ip-1",
    });

    expect(await rows()).toMatchObject([
      { reason: "BAD_SIGNATURE", company_id: alpha.id },
    ]);
  });

  it("keeps a flood against one URL to a single row", async () => {
    /*
     * The endpoint is unauthenticated, so every row here was written by whoever
     * asked. One row per request would let a single attacker fill the table.
     */
    for (let i = 0; i < 25; i++) {
      await recordUnroutableWebhook({
        webhookKeyHash: "hash-flood",
        reason: "UNKNOWN_KEY",
        ipHash: `ip-${i}`,
      });
    }

    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].attempt_count).toBe(25);
  });

  it("keeps first_seen_at while moving last_seen_at", async () => {
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-window",
      reason: "UNKNOWN_KEY",
    });
    const first = (await rows())[0];

    await recordUnroutableWebhook({
      webhookKeyHash: "hash-window",
      reason: "UNKNOWN_KEY",
    });
    const second = (await rows())[0];

    expect(second.first_seen_at.getTime()).toBe(first.first_seen_at.getTime());
    expect(second.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      first.last_seen_at.getTime(),
    );
  });

  it("does not bound itself against a rotating key", async () => {
    /*
     * Stated as a test because it is the limit of what this table can do, and
     * the reason the per-address throttle exists rather than being optional.
     * Twenty-five requests with a fresh key each time are twenty-five rows, and
     * no amount of upserting changes that.
     */
    for (let i = 0; i < 25; i++) {
      await recordUnroutableWebhook({
        webhookKeyHash: `rotating-${i}`,
        reason: "UNKNOWN_KEY",
        ipHash: "one-attacker",
      });
    }

    expect(await rows()).toHaveLength(25);
  });

  it("moves a key from unknown to bad signature", async () => {
    /* A key that starts resolving has changed what it is; current state is
       what an operator acts on. */
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-moves",
      reason: "UNKNOWN_KEY",
    });
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-moves",
      reason: "BAD_SIGNATURE",
      companyId: alpha.id,
    });

    expect(await rows()).toMatchObject([
      { reason: "BAD_SIGNATURE", company_id: alpha.id, attempt_count: 2 },
    ]);
  });
});

describe("the tenant runtime", () => {
  /*
   * No RLS here: a global table has no company_id to scope a policy on, so the
   * boundary is the grant. Default privileges gave app_runtime full CRUD when
   * the table was created; the migration revokes that and grants back only what
   * the upsert forces.
   *
   * The runtime has to WRITE this table - the webhook endpoint runs as
   * app_runtime. So the property is not "cannot touch it", it is "cannot
   * enumerate who is failing", and the tests say which columns are which.
   */
  it("cannot read which companies are failing verification", async () => {
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-secret",
      reason: "BAD_SIGNATURE",
      companyId: alpha.id,
      ipHash: "ip-secret",
    });

    const raw = rawRuntimeClient();
    try {
      for (const column of [
        "company_id",
        "reason",
        "last_ip_hash",
        "first_seen_at",
        "last_seen_at",
      ]) {
        await expect(
          raw.query(`SELECT ${column} FROM unroutable_webhooks`),
          `${column} is readable by app_runtime`,
        ).rejects.toThrow(/permission denied/i);
      }

      await expect(raw.query("SELECT * FROM unroutable_webhooks")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await raw.end();
    }
  });

  it("can read only the three columns the upsert forces", async () => {
    /*
     * Asserted so that widening the grant is a failing test rather than a quiet
     * convenience. Each of these is required by the statement itself:
     * RETURNING names id, ON CONFLICT reads its arbiter column, and the
     * increment reads the column it writes.
     */
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-readable",
      reason: "UNKNOWN_KEY",
    });

    const raw = rawRuntimeClient();
    try {
      await expect(
        raw.query("SELECT id, webhook_key_hash, attempt_count FROM unroutable_webhooks"),
      ).resolves.toBeDefined();
    } finally {
      await raw.end();
    }
  });
});

describe("retention", () => {
  it("is not something the tenant runtime can perform", async () => {
    /*
     * 30 days, and the last_seen_at index supports it - but app_runtime has no
     * DELETE here. It must not be able to erase the record of deliveries it
     * could not accept. The prune belongs with the admin client and the rest of
     * the cross-company maintenance work, which is why no prune function ships
     * from this module.
     */
    await recordUnroutableWebhook({
      webhookKeyHash: "hash-old",
      reason: "UNKNOWN_KEY",
    });

    const raw = rawRuntimeClient();
    try {
      await expect(raw.query("DELETE FROM unroutable_webhooks")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await raw.end();
    }

    expect(await rows()).toHaveLength(1);
  });
});
