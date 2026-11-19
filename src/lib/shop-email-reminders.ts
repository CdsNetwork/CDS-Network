/**
 * Reminder rules for shops (Sarah, CDS, 2026-11-19). Weekday hours only: Pacific weekends do
 * not count (src/lib/weekday-hours.ts). Every clock starts no earlier than when the shop's
 * emails were turned on, so turning a shop on never reminds it about old orders at once.
 *
 *   not_accepted   dispatched and not accepted: 24 weekday hours after the dispatch, then every
 *                  24 until the shop accepts or declines (or CDS moves the order).
 *   no_update      accepted and open (accepted, picked up, in process) with no shop update for
 *                  24 weekday hours, counted from the acceptance or the shop's last update, then
 *                  every 24 while nothing happens. A shop update is any shop action on the order
 *                  (public.shop_email_reminder_candidates, 20261120200000_shop_emails.sql).
 *   not_completed  open and not completed 48 weekday hours after the clock start, then every 12.
 *                  Pickup orders count from the acceptance; shipped orders from when the part
 *                  arrived at the shop (the inbound delivery, else Picked Up), so a part still
 *                  on its way starts no clock.
 * Completed, cancelled or reassigned orders are never candidates. When the no update and the
 * completion reminder are due together, only the completion one is sent; the other is recorded
 * as covered, so it is not sent later either.
 *
 * A reminder's key names the rule, the order, the shop, the clock start and the count, so it is
 * the same however often the cron runs, and a new one once the clock restarts or moves on.
 */
import { weekdayHours } from "@/lib/weekday-hours";

export type ReminderKind = "not_accepted" | "no_update" | "not_completed";

export type ReminderCandidate = {
  workOrderId: string;
  affiliateId: string;
  status: string;
  fulfillment: string;
  /** When the shop's emails were last turned on. */
  enabledAt: string | null;
  dispatchedAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  /** The earliest carrier delivery of an inbound leg (customer to shop). */
  arrivedAt: string | null;
  /** The shop's latest action on the order. */
  lastShopUpdateAt: string | null;
};

export type DueReminder = {
  kind: ReminderKind;
  key: string;
  /** When this reminder's clock started (ISO). */
  since: string;
  /** 1 for the first reminder of this clock, 2 for the next, and so on. */
  count: number;
  /** Due, but another reminder sent at the same time says it already. */
  covered: boolean;
};

export const NOT_ACCEPTED_HOURS = 24;
export const NO_UPDATE_HOURS = 24;
export const NOT_COMPLETED_FIRST_HOURS = 48;
export const NOT_COMPLETED_REPEAT_HOURS = 12;

const OPEN = ["accepted", "picked_up", "in_process"];

const latest = (...times: (string | null)[]): number | null => {
  const ms = times.filter((t): t is string => !!t).map((t) => Date.parse(t)).filter((n) => Number.isFinite(n));
  return ms.length ? Math.max(...ms) : null;
};

export function dueReminders(c: ReminderCandidate, now: number): DueReminder[] {
  const due: DueReminder[] = [];
  const make = (kind: ReminderKind, start: number, count: number): DueReminder => ({
    kind,
    key: `${kind}:${c.workOrderId}:${c.affiliateId}:${start}:${count}`,
    since: new Date(start).toISOString(),
    count,
    covered: false,
  });

  if (c.status === "awaiting_acceptance") {
    const start = c.dispatchedAt ? latest(c.dispatchedAt, c.enabledAt) : null;
    if (start !== null) {
      const n = Math.floor(weekdayHours(start, now) / NOT_ACCEPTED_HOURS);
      if (n >= 1) due.push(make("not_accepted", start, n));
    }
    return due;
  }
  if (!OPEN.includes(c.status)) return due;

  const last = latest(c.acceptedAt, c.lastShopUpdateAt, c.enabledAt);
  if (last !== null) {
    const n = Math.floor(weekdayHours(last, now) / NO_UPDATE_HOURS);
    if (n >= 1) due.push(make("no_update", last, n));
  }

  const base = c.fulfillment === "pickup" ? c.acceptedAt : (c.arrivedAt ?? c.pickedUpAt);
  const start = base ? latest(base, c.enabledAt) : null;
  if (start !== null) {
    const h = weekdayHours(start, now);
    if (h >= NOT_COMPLETED_FIRST_HOURS) {
      const n = 1 + Math.floor((h - NOT_COMPLETED_FIRST_HOURS) / NOT_COMPLETED_REPEAT_HOURS);
      due.push(make("not_completed", start, n));
    }
  }

  if (due.length === 2) due[0].covered = true;
  return due;
}
