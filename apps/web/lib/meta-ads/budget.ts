/**
 * Reading a daily budget somebody typed, and refusing everything else.
 *
 * A budget is the one number on this screen that spends money without anybody
 * pressing anything again, and the ways a text field goes wrong are all
 * expensive in the same direction. "1,000" parsed by Number is NaN. "1 000" is
 * NaN. A stray zero is a tenfold overspend that looks like a plausible figure.
 * parseFloat("1,000") is 1, which is worse than NaN because it succeeds.
 *
 * So this parses deliberately, returns a discriminated result, and never
 * guesses. The screen prints the parsed amount back before anything is
 * created, which is the only real defence against a typo.
 */

/** Micros per one unit of currency, matching usage events. */
const MICROS_PER_UNIT = 1_000_000n;

/** Micros per minor unit - the smallest amount Meta can actually be told. */
const MICROS_PER_MINOR_UNIT = 10_000n;

/**
 * Meta refuses a daily budget below roughly one unit of most currencies, and
 * a budget of nothing is a campaign that cannot deliver. Refusing here gives a
 * sentence a person can act on instead of a Graph error code.
 */
const MINIMUM_MICROS = 1_000_000n;

/**
 * A ceiling, and it is here to catch a typo rather than to express a policy.
 *
 * Ten million units a day is not a budget anybody means to type; it is a
 * decimal point in the wrong place or a paste of an account number. The
 * failure it prevents has no undo, which is the whole argument for having any
 * ceiling at all - and the number is generous enough that a real advertiser
 * never meets it.
 */
const MAXIMUM_MICROS = 10_000_000n * MICROS_PER_UNIT;

export type BudgetResult =
  | { ok: true; micros: bigint }
  | { ok: false; error: string };

export function parseDailyBudget(raw: string, currency: string): BudgetResult {
  const text = raw.trim().replace(/[\s,]/g, "");

  if (text === "") return { ok: false, error: "Enter a daily budget." };

  /*
   * Matched, not coerced. parseFloat("1,000") is 1 and parseFloat("12abc") is
   * 12 - both succeed, both are wrong, and neither leaves anything to report.
   * At most two decimal places, because a budget is expressed in the
   * currency's minor unit and a third place is a number Meta cannot take.
   */
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return {
      ok: false,
      error: `Enter the daily budget as a plain amount in ${currency}, for example 2500 or 2500.50.`,
    };
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const micros =
    BigInt(whole) * MICROS_PER_UNIT +
    BigInt(fraction.padEnd(6, "0").slice(0, 6));

  if (micros % MICROS_PER_MINOR_UNIT !== 0n) {
    /* Unreachable given the two-decimal rule above, and asserted rather than
       assumed: minorUnitsFromMicros throws on a value Meta cannot express, and
       a throw inside a server action is a 500 rather than a sentence. */
    return { ok: false, error: `That amount is finer than ${currency} can express.` };
  }

  if (micros < MINIMUM_MICROS) {
    return { ok: false, error: `A daily budget below 1 ${currency} will not deliver.` };
  }

  if (micros > MAXIMUM_MICROS) {
    return {
      ok: false,
      error: `That is more than 10,000,000 ${currency} a day. Check the amount - this looks like a misplaced decimal point.`,
    };
  }

  return { ok: true, micros };
}

/** Thousands separators, in threes, with no locale involved. */
function group(value: bigint): string {
  const digits = value.toString();
  let out = "";

  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }

  return out;
}

/**
 * Micros back to something a person reads, in the account's own currency.
 *
 * Takes the currency as a LABEL and never converts. There is no exchange rate
 * in this system, and a formatter that accepted a target currency would be the
 * first place one appeared.
 *
 * ---------------------------------------------------------------------------
 * Grouped in threes by hand, and not with toLocaleString
 * ---------------------------------------------------------------------------
 *
 * The first version used `toLocaleString("en-IN")`, which was caught by its own
 * test. Two things were wrong with it and only one was obvious.
 *
 * It applies the lakh-crore grouping to EVERY currency, so a USD figure on the
 * account beside it rendered as 9,00,71,99,254 - a number denominated in one
 * currency and punctuated in another's convention, on the one screen whose
 * whole design is that the two are never mixed up.
 *
 * And a locale-dependent formatter is a rendered value that depends on the
 * machine's ICU build. The conventions have this already, one step out: a
 * rendered value must not come from the developer's .env, and this is the same
 * rule applied to their Node install. A baseline recorded on one ICU version
 * would fail on another for a reason nobody would find.
 */
export function formatMicros(micros: bigint, currency: string): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;

  const whole = abs / MICROS_PER_UNIT;
  const fraction = (abs % MICROS_PER_UNIT) / MICROS_PER_MINOR_UNIT;

  const body = `${group(whole)}.${fraction.toString().padStart(2, "0")}`;

  return `${negative ? "-" : ""}${body} ${currency}`;
}
