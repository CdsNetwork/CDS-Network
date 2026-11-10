/**
 * Carrier pickups for a label: the form check, the request body for POST /v2/pickups and
 * the mapping of its answer. Pure functions: no network, no database, safe to import from
 * client components.
 *
 * Contract (ShipStation API V2 docs, read 2026-11-10:
 * https://docs.shipstation.com/openapi/package_pickups/schedule_pickup.md and
 * https://docs.shipstation.com/schedule-pickups.md):
 *   POST /v2/pickups  { label_ids: [..], contact_details: { name, email, phone }, pickup_notes?,
 *                       pickup_window: { start_at, end_at } }   (all required but pickup_notes)
 *                     -> { pickup_id, label_ids, carrier_id, confirmation_number (may be null),
 *                          warehouse_id, pickup_address, contact_details, pickup_notes,
 *                          pickup_windows: [{ start_at, end_at }], created_at, request_id, errors }
 *   DELETE /v2/pickups/{pickup_id}  -> { pickup_id }
 * The carrier collects at the labels' ship-from address; all labels must be from one carrier.
 *
 * Time zone: the docs say the window is in the time zone of the pickup address, "not the
 * timezone sent in the request", and their sample sends local times without an offset
 * ("2024-11-11T15:00:00.000"). So the portal sends the ready and close times exactly as CDS
 * typed them, without an offset. The zone (from the ship-from state) is used only to check
 * the date is not in the past and to store and show the window.
 */

export type PickupForm = { date: string; readyTime: string; closeTime: string; notes: string };

export type PickupContact = { name: string; email: string; phone: string };

export type PickupWindow = {
  /** YYYY-MM-DD, local to the pickup address. */
  date: string;
  /** HH:MM, 24 hour, local to the pickup address. */
  readyTime: string;
  closeTime: string;
  /** IANA zone of the pickup address. */
  timeZone: string;
  /** The same window as instants, for the database. */
  startIso: string;
  endIso: string;
};

/** Carriers print short driver notes only; ShipStation passes them on to carriers that use them. */
export const MAX_PICKUP_NOTES = 200;

/**
 * Main time zone of each US state (by where most people live). A few states span two zones
 * (for example the Florida panhandle, west Kentucky, east Tennessee, west Texas); there the
 * main zone is used.
 */
const STATE_ZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

/** The portal's home zone (work order dates are Pacific), used when the state is unknown. */
export const DEFAULT_PICKUP_ZONE = "America/Los_Angeles";

export function zoneForState(state: string | null | undefined): string {
  return STATE_ZONES[(state ?? "").trim().toUpperCase()] ?? DEFAULT_PICKUP_ZONE;
}

/**
 * The state of a label's ship_from_summary. The portal writes it as
 * "Company, street, City ST ZIP" (labels.ts, state in capitals), so the state is the two
 * capitals before the ZIP (which has a digit).
 */
export function stateFromSummary(summary: string | null | undefined): string | null {
  const m = /\b([A-Z]{2}) (?=[0-9A-Z -]*\d)[0-9A-Z -]+$/.exec((summary ?? "").trim());
  return m ? m[1] : null;
}

/** What a pickup cannot be booked for, or null. Test labels never reach a carrier. */
export function pickupRefusal(label: { is_test: boolean }, testLabels: boolean): string | null {
  if (testLabels) return "Pickups can only be booked for real labels (the portal is making test labels).";
  if (label.is_test) return "Pickups can only be booked for real labels (this is a test label).";
  return null;
}

// ---------------------------------------------------------------- dates in a zone

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function partsIn(instant: number, zone: string): Parts {
  const out: Record<string, number> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (const p of fmt.formatToParts(new Date(instant))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(instant: number, zone: string): number {
  const p = partsIn(instant, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(instant / 1000) * 1000;
}

/** The instant of a local date and time in a zone (daylight saving included). */
export function zonedToUtc(date: string, time: string, zone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = offsetMs(guess, zone);
  let t = guess - first;
  const second = offsetMs(t, zone);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** Today's date (YYYY-MM-DD) in a zone. */
export function todayIn(zone: string, now: Date = new Date()): string {
  const p = partsIn(now.getTime(), zone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/**
 * Checks the pickup form: a real date that is today or later at the pickup address, a ready
 * and a close time with the close time after the ready time, and a close time still ahead
 * when the pickup is today. Notes are optional, at most MAX_PICKUP_NOTES characters.
 */
export function validatePickupForm(
  form: PickupForm,
  zone: string,
  now: Date = new Date(),
): { ok: true; window: PickupWindow; notes: string | null } | { ok: false; error: string } {
  const date = clean(form.date);
  const ready = clean(form.readyTime);
  const close = clean(form.closeTime);
  if (!validDate(date)) return { ok: false, error: "Enter the pickup date." };
  if (!TIME.test(ready)) return { ok: false, error: "Enter the ready time (when the package is ready)." };
  if (!TIME.test(close)) return { ok: false, error: "Enter the close time (when the dock closes)." };
  if (close <= ready) return { ok: false, error: "The close time must be after the ready time." };
  if (date < todayIn(zone, now)) return { ok: false, error: "The pickup date is in the past." };
  const start = zonedToUtc(date, ready, zone);
  const end = zonedToUtc(date, close, zone);
  if (end.getTime() <= now.getTime()) return { ok: false, error: "The close time has already passed today. Pick a later time or date." };
  const notes = clean(form.notes);
  if (notes.length > MAX_PICKUP_NOTES) return { ok: false, error: `Notes for the driver can be at most ${MAX_PICKUP_NOTES} characters.` };
  return {
    ok: true,
    window: { date, readyTime: ready, closeTime: close, timeZone: zone, startIso: start.toISOString(), endIso: end.toISOString() },
    notes: notes || null,
  };
}

// ---------------------------------------------------------------- request and answer

export type PickupRequest = {
  label_ids: string[];
  contact_details: PickupContact;
  pickup_notes?: string;
  pickup_window: { start_at: string; end_at: string };
};

/** Local date and time without an offset, as in the ShipStation sample: 2024-11-11T15:00:00.000. */
const localStamp = (date: string, time: string) => `${date}T${time}:00.000`;

/**
 * The CDS contact for the carrier (Shipping settings name, email and phone). All three are
 * required by ShipStation.
 */
export function pickupContact(s: { from_name?: string | null; from_company?: string | null; from_email?: string | null; from_phone?: string | null } | null):
  | { ok: true; contact: PickupContact }
  | { ok: false; error: string } {
  const name = clean(s?.from_name) || clean(s?.from_company);
  const email = clean(s?.from_email);
  const phone = clean(s?.from_phone);
  const missing = [!name && "name", !email && "email", !phone && "phone"].filter(Boolean);
  if (missing.length) return { ok: false, error: `Add CDS's ${missing.join(", ")} under Shipping settings: the carrier needs a contact for the pickup.` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "The email under Shipping settings is not a valid address." };
  return { ok: true, contact: { name: name.slice(0, 100), email, phone } };
}

/** Body for POST /v2/pickups. */
export function buildPickupRequest(input: { labelId: string; contact: PickupContact; window: PickupWindow; notes: string | null }): PickupRequest {
  const labelId = input.labelId.trim();
  if (!labelId) throw new Error("The label has no ShipStation id.");
  return {
    label_ids: [labelId],
    contact_details: input.contact,
    ...(input.notes ? { pickup_notes: input.notes.slice(0, MAX_PICKUP_NOTES) } : {}),
    pickup_window: {
      start_at: localStamp(input.window.date, input.window.readyTime),
      end_at: localStamp(input.window.date, input.window.closeTime),
    },
  };
}

export type BookedPickup = { pickupId: string; confirmationNumber: string | null; carrierId: string | null };

type RawPickup = {
  pickup_id?: string;
  carrier_id?: string;
  confirmation_number?: string | null;
  errors?: { message?: string }[];
};

/** The portal's view of a POST /v2/pickups answer. */
export function mapPickup(body: unknown): BookedPickup {
  const p = (body ?? {}) as RawPickup;
  if (!p.pickup_id) {
    const why = (p.errors ?? []).map((e) => clean(e?.message)).filter(Boolean).join("; ");
    throw new Error(why ? `ShipStation did not book the pickup: ${why}` : "ShipStation did not return the new pickup");
  }
  return {
    pickupId: p.pickup_id,
    confirmationNumber: clean(p.confirmation_number) || null,
    carrierId: p.carrier_id ?? null,
  };
}

// ---------------------------------------------------------------- display

/** "Wed, Nov 11, 2026, 9:00 AM to 5:00 PM MST", in the pickup address's zone. */
export function pickupWindowText(startIso: string, endIso: string, zone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  let tz = zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_PICKUP_ZONE;
  }
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(start);
  const time = (d: Date, withZone: boolean) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" as const } : {}) }).format(d);
  return `${day}, ${time(start, false)} to ${time(end, true)}`;
}
