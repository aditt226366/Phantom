import { PLATFORM_TIMEZONE, PLATFORM_TIMEZONE_LABEL } from "@whatsapp-os/core";

/**
 * Rendering numbers a person is going to act on.
 *
 * Intl throughout rather than division and toFixed. Hand-rolled money
 * formatting gets the symbol position wrong for half the world, the grouping
 * wrong for India — ₹12,34,567 is not ₹1,234,567 — and the rounding wrong at
 * exactly the sub-cent values micros exist to preserve.
 */

const MICROS_PER_UNIT = 1_000_000;

/**
 * Micros to a currency string.
 *
 * The division is the only place rounding is allowed to happen, which is the
 * whole reason the column is integer micros: everything upstream stays exact
 * and the loss is confined to the last step, where it is visible.
 */
export function formatMicros(micros: bigint, currency: string): string {
  const units = Number(micros) / MICROS_PER_UNIT;

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    /*
     * Two decimals normally, but never rounding a real charge to zero: a
     * fraction of a paisa still has to read as "some money", or the panel
     * claims a month of AI replies cost nothing.
     */
    minimumFractionDigits: 2,
    maximumFractionDigits: units !== 0 && Math.abs(units) < 0.01 ? 6 : 2,
  }).format(units);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

/** A date, in the zone the platform's figures are computed in. */
export function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: PLATFORM_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(value);
}

/**
 * The one timestamp formatter.
 *
 * Every time this panel prints goes through here, in the same zone the
 * "today" boundaries are computed in. The alternative is two figures on
 * adjacent screens disagreeing by five and a half hours with neither of them
 * labelled — "8 calls today" measured from IST midnight, beside a last-login
 * rendered in whatever zone the container runs in.
 *
 * DD/MM/YYYY HH:MM:SS, which is unambiguous for the audience: 08/09 is the
 * eighth of September here and the ninth of August in en-US, and a support
 * conversation about the wrong day costs more than the four characters.
 *
 * Null is "Never" rather than a dash. A user who has never signed in is a
 * fact worth stating; a dash reads as missing data.
 */
export function formatTimestamp(value: Date | null | undefined): string {
  if (!value) return "Never";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PLATFORM_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return (
    `${read("day")}/${read("month")}/${read("year")} ` +
    `${read("hour")}:${read("minute")}:${read("second")}`
  );
}

/** The same instant with the zone spelled out, where there is room for it. */
export function formatTimestampWithZone(value: Date | null | undefined): string {
  const formatted = formatTimestamp(value);
  return formatted === "Never"
    ? formatted
    : `${formatted} ${PLATFORM_TIMEZONE_LABEL}`;
}
