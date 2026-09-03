/**
 * Does the Page a tenant picked route its click-to-WhatsApp traffic to a
 * number we can actually see?
 *
 * ---------------------------------------------------------------------------
 * Why this is a check and not a constraint
 * ---------------------------------------------------------------------------
 *
 * A mismatch is NOT an error. An agency running ads for a business whose
 * WhatsApp lives somewhere else is an ordinary arrangement, and so is a tenant
 * who has two Pages and picked the wrong one by mistake. Refusing the selection
 * would block the first and give the second no information; allowing it in
 * silence gives the second none either.
 *
 * What a mismatch actually means is narrow and worth saying exactly: the ads
 * will run, the money will be spent, and NOTHING WILL EVER ARRIVE IN THIS
 * INBOX. The referral webhook that carries the ad id lands on whichever
 * account owns the number, so the attribution this whole phase is built on
 * fires for somebody else. That is a thing to say before a tenant spends
 * money, not after.
 *
 * ---------------------------------------------------------------------------
 * Digits only, on both sides
 * ---------------------------------------------------------------------------
 *
 * Meta reports the linked number in whatever shape the Page carries - with a
 * plus, with spaces, sometimes neither - and our own display_number comes from
 * a different Graph endpoint with its own formatting. Comparing the strings
 * gives a false mismatch on formatting alone, which would tell a correctly
 * configured tenant their setup is broken. Comparing digits is what makes the
 * answer about the number rather than about punctuation.
 */

export type LinkedNumberVerdict =
  /** Meta named a number and it is one of ours. */
  | { kind: "matched"; whatsappNumberId: string; displayNumber: string }
  /** Meta named a number that belongs to somebody else. */
  | { kind: "elsewhere"; linkedPhoneE164: string }
  /** The Page has no WhatsApp connection at all. */
  | { kind: "unlinked" };

export interface OwnNumber {
  id: string;
  displayNumber: string;
}

/** Everything that is not a digit, removed. */
function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Compare on the longest common tail rather than on equality.
 *
 * A number can be written with a country code on one side and without it on
 * the other, and neither source is authoritative about which. Requiring exact
 * equality reports a mismatch for a correctly linked Page whenever the two
 * endpoints disagree about the prefix - a false alarm on the only screen where
 * this warning is meant to be trusted.
 *
 * Ten digits is the threshold, which is the length of a subscriber number in
 * every market this product sells into. Shorter than that and a suffix match
 * starts being a coincidence rather than a match.
 */
const MIN_SIGNIFICANT_DIGITS = 10;

function sameNumber(a: string, b: string): boolean {
  const left = digits(a);
  const right = digits(b);

  if (left.length < MIN_SIGNIFICANT_DIGITS || right.length < MIN_SIGNIFICANT_DIGITS) {
    /* Too short to be sure. Falls back to equality, which is strict and
       therefore reports "elsewhere" rather than claiming a match it cannot
       stand behind - the safe direction, since the consequence of a false
       match is a tenant told their attribution will work when it will not. */
    return left === right && left.length > 0;
  }

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;

  return longer.endsWith(shorter);
}

export function checkLinkedNumber(
  linkedPhone: string | null,
  ownNumbers: readonly OwnNumber[],
): LinkedNumberVerdict {
  if (!linkedPhone || digits(linkedPhone).length === 0) return { kind: "unlinked" };

  for (const own of ownNumbers) {
    if (sameNumber(linkedPhone, own.displayNumber)) {
      return {
        kind: "matched",
        whatsappNumberId: own.id,
        displayNumber: own.displayNumber,
      };
    }
  }

  return { kind: "elsewhere", linkedPhoneE164: linkedPhone };
}

/** What the connect screen says about it. */
export function linkedNumberMessage(verdict: LinkedNumberVerdict): string {
  switch (verdict.kind) {
    case "matched":
      return `Replies will arrive on ${verdict.displayNumber}, which is one of your numbers.`;
    case "elsewhere":
      /*
       * Names the number Meta reported. Without it the sentence is "this is
       * linked to a different number" and the tenant has no way to find out
       * which - the information is in Meta's Business Manager, three screens
       * from anywhere, and they came here to avoid that.
       */
      return `This Page sends replies to ${verdict.linkedPhoneE164}, which is not one of your numbers. Ads will run and spend, but the conversations they start will not appear in this inbox.`;
    case "unlinked":
      return "This Page has no WhatsApp number linked to it yet. Link one in Meta Business Manager, or click-to-WhatsApp ads from it will have nowhere to send people.";
  }
}
