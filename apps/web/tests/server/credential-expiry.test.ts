import { describe, expect, it } from "vitest";
import { expiryNotice, trackedExpiry } from "@/lib/credential-expiry";

/**
 * What the integrations panel says about a credential's expiry, asserted as a
 * value rather than as a substring of a component.
 *
 * The conventions record why: a test that `company-header.tsx` CONTAINS
 * "Reactivate" stayed green after the control was deleted, because the word
 * survived in a neighbouring heading. The decision is a function, both branches
 * are asserted, and the card renders whatever this returns.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

describe("finding the expiry that governs an integration", () => {
  it("reads the tracked credential and ignores the others", () => {
    /*
     * The ad account id is stored, sealed and shown as a last4 like everything
     * else, and it does not expire. Picking the first secret with a date on it
     * would work today and break the moment a second dated credential exists.
     */
    const expires = inDays(30);

    expect(
      trackedExpiry([
        { key: "META_AD_ACCOUNT_ID", expiresAt: null },
        { key: "META_ADS_ACCESS_TOKEN", expiresAt: expires },
      ]),
    ).toBe(expires);
  });

  it("is null for a provider with no tracked credential at all", () => {
    expect(
      trackedExpiry([
        { key: "GOOGLE_PRIVATE_KEY", expiresAt: null },
        { key: "GOOGLE_SHEETS_ID", expiresAt: null },
      ]),
    ).toBeNull();
  });
});

describe("what the panel says", () => {
  it("says nothing at all when there is nothing to say", () => {
    /*
     * Both quiet states, and they must stay quiet. A panel that renders a line
     * about expiry on every integration teaches operators to skim past the one
     * that matters.
     */
    for (const expiresAt of [null, inDays(90)]) {
      const notice = expiryNotice(expiresAt, NOW, "Meta Ads");

      expect(notice.message).toBeNull();
      expect(notice.demotes).toBe(false);
      expect(notice.promptsReconnect).toBe(false);
    }
  });

  it("warns without demoting while the token still works", () => {
    /*
     * The line this whole feature turns on. An expiring token serves traffic
     * perfectly well, and the documented operator response to NOT_CONNECTED is
     * to re-enter credentials - so demoting a week early buys a week of people
     * retyping a working secret and a support ticket about a product that was
     * never down.
     */
    const notice = expiryNotice(inDays(3), NOW, "Meta Ads");

    expect(notice.state).toBe("expiring");
    expect(notice.demotes).toBe(false);
    expect(notice.promptsReconnect).toBe(true);
    expect(notice.tone).toBe("warning");
    expect(notice.message).toContain("expires soon");
  });

  it("demotes once the token has actually lapsed, and says what stopped", () => {
    const notice = expiryNotice(inDays(-1), NOW, "Meta Ads");

    expect(notice.state).toBe("expired");
    expect(notice.demotes).toBe(true);
    expect(notice.tone).toBe("error");

    /*
     * The copy names the consequence rather than the fault. "Something is
     * wrong with your integration" is a sentence nobody can act on; "ad spend
     * and campaign changes stopped" is the thing the operator actually needs
     * to know before they decide how urgent this is.
     */
    expect(notice.message).toContain("Ad spend and campaign changes stopped");
    expect(notice.message).toContain("reconnect");
  });

  it("names the provider it is talking about", () => {
    /* The admin panel shows three cards. A message that did not say which
       integration had expired would be read against whichever card the
       operator looked at first. */
    expect(expiryNotice(inDays(-1), NOW, "Meta Ads").message).toContain("Meta Ads");
    expect(expiryNotice(inDays(-1), NOW, "WhatsApp Cloud").message).toContain(
      "WhatsApp Cloud",
    );
  });
});
