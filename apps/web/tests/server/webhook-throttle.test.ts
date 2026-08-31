import { LoginScope } from "@whatsapp-os/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_FAILURES_PER_IP,
  WEBHOOK_SENTINEL,
  checkLocked,
  checkWebhookAllowed,
  clearWebhookFailures,
  recordFailure,
  recordWebhookFailure,
} from "@/lib/auth/lockout.ts";
import { hashIp } from "@/lib/auth/ip-hash.ts";
import { truncateAll } from "../../../../packages/db/tests/helpers.ts";

/**
 * The public endpoint's throttle, against the real table.
 *
 * P3, and it reverses the obvious design. Keying on the webhook key would let
 * anyone who learns a tenant's URL flood it until that key locks out - genuine
 * Meta deliveries then refused, failures accumulating, and Meta disabling the
 * subscription in about a week. An attacker severing a customer's WhatsApp
 * using our own protection. So the counter is the source address, and only the
 * source address.
 */

const IP = "203.0.113.10";

beforeEach(async () => {
  await truncateAll();
});

describe("an address sending deliveries that do not verify", () => {
  it("is allowed until it crosses the threshold, then locked", async () => {
    const ipHash = hashIp(IP);

    expect((await checkWebhookAllowed(ipHash)).locked).toBe(false);

    for (let i = 0; i < MAX_WEBHOOK_FAILURES_PER_IP; i++) {
      await recordWebhookFailure(ipHash);
    }

    const state = await checkWebhookAllowed(ipHash);
    expect(state.locked).toBe(true);
    expect(state.until).toBeInstanceOf(Date);
  });

  it("is forgiven once a delivery verifies", async () => {
    const ipHash = hashIp(IP);

    for (let i = 0; i < MAX_WEBHOOK_FAILURES_PER_IP; i++) {
      await recordWebhookFailure(ipHash);
    }
    expect((await checkWebhookAllowed(ipHash)).locked).toBe(true);

    /*
     * The recovery path. A stale app secret makes genuine Meta traffic fail its
     * signature, so Meta's own addresses accumulate failures through no fault
     * of their own; once the tenant fixes it, the first delivery that verifies
     * clears the count rather than leaving the fix to look broken for an hour.
     */
    await clearWebhookFailures(ipHash);

    expect((await checkWebhookAllowed(ipHash)).locked).toBe(false);
  });
});

describe("what the counter is keyed on", () => {
  it("stores a hash, never the address", async () => {
    const ipHash = hashIp(IP);
    await recordWebhookFailure(ipHash);

    /*
     * The endpoint is unauthenticated, so the addresses reaching it are not a
     * set this system chose. Storing them raw turns a throttle counter into a
     * log of who probed us.
     */
    expect(ipHash).not.toContain(IP);
    expect(ipHash).toHaveLength(64);
  });

  it("does not lock the same address out of signing in", async () => {
    const ipHash = hashIp(IP);

    for (let i = 0; i < MAX_WEBHOOK_FAILURES_PER_IP; i++) {
      await recordWebhookFailure(ipHash);
    }

    /*
     * Its own LoginScope member, so the rows cannot collide. A shared scope
     * would mean an address locked out of the webhook is locked out of the
     * product - and these are behind a NAT as often as not.
     */
    expect((await checkLocked("someone", IP, LoginScope.TENANT)).locked).toBe(false);
    expect((await checkLocked(WEBHOOK_SENTINEL, ipHash)).locked).toBe(false);
  });

  it("counts each address separately", async () => {
    const noisy = hashIp("198.51.100.5");
    const quiet = hashIp("198.51.100.6");

    for (let i = 0; i < MAX_WEBHOOK_FAILURES_PER_IP; i++) {
      await recordWebhookFailure(noisy);
    }

    expect((await checkWebhookAllowed(noisy)).locked).toBe(true);
    /* One flooding source must not take the endpoint away from everyone else,
       which is the failure keying on the webhook key would have produced. */
    expect((await checkWebhookAllowed(quiet)).locked).toBe(false);
  });

  it("does not lock an address out of the webhook by failing to sign in", async () => {
    /* The other direction of the same isolation, since sign-in throttling is
       far tighter and would otherwise leak into this. */
    for (let i = 0; i < 10; i++) {
      await recordFailure("someone", IP);
    }

    expect((await checkWebhookAllowed(hashIp(IP))).locked).toBe(false);
  });
});
