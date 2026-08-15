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

export function formatDateTime(value: Date): string {
  return `${new Intl.DateTimeFormat("en-IN", {
    timeZone: PLATFORM_TIMEZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value)} ${PLATFORM_TIMEZONE_LABEL}`;
}
