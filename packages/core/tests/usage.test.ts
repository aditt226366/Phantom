import { describe, expect, it } from "vitest";
import {
  ACTIVE_PRICE_VERSION,
  USAGE_KINDS,
  USAGE_PRICES,
  findPrice,
  usageDedupeKey,
} from "../src/usage.ts";

describe("USAGE_PRICES", () => {
  it("prices every kind at the active version", () => {
    /*
     * The list of kinds and the list of prices are two things that can drift.
     * A kind with no entry is not a crash — the emitter writes a null cost —
     * so nothing else would ever report it.
     */
    for (const kind of USAGE_KINDS) {
      expect(findPrice(kind, ACTIVE_PRICE_VERSION), kind).toBeDefined();
    }
  });

  it("never gives one kind two currencies at the same version", () => {
    /*
     * findPrice returns the first match, which is only correct while a
     * (kind, version) is unambiguous. Multi-currency pricing needs an explicit
     * resolution rule, and this failing is how that gets asked for rather than
     * silently resolved by map ordering.
     */
    const seen = new Map<string, string>();

    for (const price of USAGE_PRICES.values()) {
      const key = `${price.kind}|${price.version}`;
      const existing = seen.get(key);

      expect(
        existing === undefined || existing === price.currency,
        `${key} is priced in both ${String(existing)} and ${price.currency}`,
      ).toBe(true);

      seen.set(key, price.currency);
    }
  });

  it("states prices in micros, as integers", () => {
    /* A fractional micro is a rounding decision hiding in a constant. */
    for (const price of USAGE_PRICES.values()) {
      expect(Number.isInteger(price.micros), price.kind).toBe(true);
      expect(price.micros).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses ISO 4217 currency codes", () => {
    for (const price of USAGE_PRICES.values()) {
      expect(price.currency).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("findPrice", () => {
  it("returns nothing for an unknown kind rather than throwing", () => {
    /*
     * The emitter depends on this: a usage record must never be the reason a
     * provider call fails, so the missing-price path returns and is recorded
     * as unpriced.
     */
    expect(findPrice("nothing.prices.this")).toBeUndefined();
  });

  it("returns nothing for a version that does not exist", () => {
    /* An old row's version stays meaningful even once prices move on. */
    expect(findPrice("integration.verify", 9999)).toBeUndefined();
  });

  it("defaults to the active version", () => {
    expect(findPrice("integration.verify")).toEqual(
      findPrice("integration.verify", ACTIVE_PRICE_VERSION),
    );
  });
});

describe("usageDedupeKey", () => {
  it("is deterministic", () => {
    expect(usageDedupeKey("integration.verify", "job1", "int1")).toBe(
      usageDedupeKey("integration.verify", "job1", "int1"),
    );
  });

  it("separates different work", () => {
    expect(usageDedupeKey("integration.verify", "job1", "int1")).not.toBe(
      usageDedupeKey("integration.verify", "job1", "int2"),
    );
  });

  it("includes the kind, so two kinds of work on one job do not collide", () => {
    /* Two kinds that genuinely run against the same subject: a Verse answer and
       the lead score computed from it share our message id. Before, this used
       `integration.test`, which has since been deleted for being a kind nothing
       could write. */
    expect(usageDedupeKey("verse.reply", "msg1")).not.toBe(
      usageDedupeKey("verse.lead_score", "msg1"),
    );
  });
});
