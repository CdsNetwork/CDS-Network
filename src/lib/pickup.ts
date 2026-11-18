/**
 * Pickup day and window (Clyde, CDS, 2026-11-18). A shop accepting a pickup job chooses the
 * day it picks the part up (a Pacific date, today or later) and the time window; it may change
 * both until the part is picked up. The database checks the same rules
 * (20261119130000_shop_pickup_date.sql). Safe on server and client.
 */
import { PICKUP_WINDOWS, pickupWindowLabel } from "@/lib/format";

/**
 * The windows a shop picks from with the day. "Tomorrow" (2026-11-17) is replaced by choosing
 * tomorrow's date; older orders keep it and still show it.
 */
export const SHOP_PICKUP_WINDOWS = PICKUP_WINDOWS.filter((w) => w.value !== "tomorrow");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a real calendar date written as YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The date `days` after a YYYY-MM-DD date. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Fri" for "2026-11-20". */
export function weekdayOf(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
}

/** The latest pickup day a shop may choose: one year after today. */
export const PICKUP_DAYS_AHEAD = 365;

/** Why a pickup day and window cannot be saved, or null when they can. `today` is the Pacific date. */
export function pickupChoiceError(day: string, window: string, today: string): string | null {
  if (!day || !isDay(day)) return "Choose the pickup day.";
  if (day < today) return "The pickup day cannot be in the past.";
  if (day > addDays(today, PICKUP_DAYS_AHEAD)) return "Choose a pickup day within the next year.";
  if (!SHOP_PICKUP_WINDOWS.some((w) => w.value === window)) return "Choose a pickup window.";
  return null;
}

/**
 * The pickup ETA as shown to CDS and the shop: "Fri 2026-11-20, 8:00 AM - 10:00 AM". An order
 * accepted before the day existed shows its window only.
 */
export function pickupEtaLabel(window: string | null | undefined, day: string | null | undefined): string {
  if (!window) return pickupWindowLabel(window);
  if (!day) return pickupWindowLabel(window);
  return `${weekdayOf(day)} ${day}, ${pickupWindowLabel(window)}`;
}
