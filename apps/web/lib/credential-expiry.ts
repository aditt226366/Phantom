import {
  EXPIRY_TRACKED_KEYS,
  tokenExpiryState,
  type TokenExpiryState,
} from "@whatsapp-os/core/integrations";

/**
 * What the integrations panel says about a credential's expiry.
 *
 * A function rather than a ternary inside the card, for the reason the
 * conventions give about `company-header.tsx`: a test that a component
 * *contains* a word stayed green after the control it described was deleted,
 * because the word survived in a neighbouring heading. Extracting the decision
 * and asserting both branches is two lines more and actually fails.
 *
 * The other half of why it is here: three things read this decision - the
 * badge, the banner and the reconnect button - and they must agree. A card
 * showing a red banner beside a CONNECTED badge is a panel an operator stops
 * trusting, and the operator acts on the badge.
 */

export interface ExpiryNotice {
  state: TokenExpiryState;
  /** Whether the badge must read NOT_CONNECTED because of this. */
  demotes: boolean;
  /** Whether to offer the reconnect. Expiring counts; healthy does not. */
  promptsReconnect: boolean;
  /** The sentence, or null when there is nothing worth saying. */
  message: string | null;
  /** How loudly to say it. */
  tone: "none" | "warning" | "error";
}

/** The stored expiry for whichever credential of this integration carries one. */
export function trackedExpiry(
  secrets: readonly { key: string; expiresAt: Date | null }[],
): Date | null {
  for (const secret of secrets) {
    if (EXPIRY_TRACKED_KEYS.has(secret.key)) return secret.expiresAt;
  }
  return null;
}

export function expiryNotice(
  expiresAt: Date | null,
  now: Date,
  /** What the tenant has to go and do. Named so the copy can point at it. */
  providerLabel: string,
): ExpiryNotice {
  const state = tokenExpiryState(expiresAt, now);

  if (state === "expired") {
    return {
      state,
      demotes: true,
      promptsReconnect: true,
      /*
       * Says what stopped, not that something is wrong. A3 moved the token to
       * the tenant, so this sentence is the only thing standing between an
       * expired credential and a fortnight of a campaign running unwatched
       * while the spend figure quietly stops moving.
       */
      message: `The ${providerLabel} access token has expired. Ad spend and campaign changes stopped at that point; reconnect to resume them.`,
      tone: "error",
    };
  }

  if (state === "expiring") {
    return {
      state,
      demotes: false,
      promptsReconnect: true,
      /*
       * Not a demotion. The credential still works, and the documented
       * operator response to NOT_CONNECTED is to re-enter credentials - so
       * demoting here would buy a week of people retyping a working secret.
       */
      message: `The ${providerLabel} access token expires soon. Reconnect before it lapses to avoid a gap in ad spend.`,
      tone: "warning",
    };
  }

  return {
    state,
    demotes: false,
    promptsReconnect: false,
    message: null,
    tone: "none",
  };
}
