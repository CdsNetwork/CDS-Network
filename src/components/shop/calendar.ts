/**
 * Shop calendar (Clyde, CDS, 2026-11-18): a month of the shop's own jobs. A pickup job sits on
 * the pickup day the shop chose, with its window; a shipped job sits on the Pacific day the
 * filters arrived at the shop (shop-dates receivedAt). A job without a date is not on it.
 * Safe on server and client.
 */
import { date, PICKUP_WINDOWS, type WoStatus } from "@/lib/format";

/** A job as the calendar reads it (same visibility as the job list). */
export type CalendarJob = {
  id: string;
  wo_number: number;
  status: WoStatus;
  fulfillment: string;
  customer_name: string;
  location_label: string;
  unit_number: string;
  pickup_date: string | null;
  pickup_window: string | null;
  /** When the part arrived at the shop (shop-dates receivedAt), or null. */
  received_at: string | null;
};

export type CalendarEntry = {
  id: string;
  wo_number: number;
  status: WoStatus;
  /** "pickup": the shop picks the part up that day; "received": the shipped part arrived. */
  kind: "pickup" | "received";
  day: string;
  window: string | null;
  customer_name: string;
  location_label: string;
  unit_number: string;
};

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** The month of ?month=YYYY-MM, else the month of `today` (a Pacific YYYY-MM-DD date). */
export function parseMonth(raw: string | undefined, today: string): string {
  const m = MONTH_RE.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 2000 && Number(m[1]) <= 2100) return raw as string;
  return today.slice(0, 7);
}

/** The month `delta` months after `month`. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const daysIn = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** First and last date of the month. */
export function monthRange(month: string): { first: string; last: string } {
  return { first: `${month}-01`, last: `${month}-${pad(daysIn(month))}` };
}

/** The month in weeks from Sunday; days outside the month are null. */
export function monthWeeks(month: string): (string | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= daysIn(month); d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const windowOrder = (w: string | null) => {
  const i = PICKUP_WINDOWS.findIndex((p) => p.value === w);
  return i < 0 ? PICKUP_WINDOWS.length : i;
};

/**
 * The calendar's entries by day (only days of `month`, in date order). Within a day: pickups by
 * window (Need to coordinate last), then parts that arrived; then by WO number.
 */
export function calendarEntries(jobs: CalendarJob[], month: string): Map<string, CalendarEntry[]> {
  const entries: CalendarEntry[] = [];
  for (const j of jobs) {
    const pickup = j.fulfillment === "pickup";
    const day = pickup ? j.pickup_date : j.received_at ? date(j.received_at) : null;
    if (!day || !day.startsWith(`${month}-`)) continue;
    if (pickup && !j.pickup_window) continue;
    entries.push({
      id: j.id,
      wo_number: j.wo_number,
      status: j.status,
      kind: pickup ? "pickup" : "received",
      day,
      window: pickup ? j.pickup_window : null,
      customer_name: j.customer_name,
      location_label: j.location_label,
      unit_number: j.unit_number,
    });
  }
  entries.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.kind === b.kind ? 0 : a.kind === "pickup" ? -1 : 1) ||
      windowOrder(a.window) - windowOrder(b.window) ||
      a.wo_number - b.wo_number,
  );
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  return byDay;
}
