import { describe, expect, it } from "vitest";
import {
  buildPickupRequest,
  DEFAULT_PICKUP_ZONE,
  mapPickup,
  pickupContact,
  pickupRefusal,
  pickupWindowText,
  stateFromSummary,
  todayIn,
  validatePickupForm,
  zonedToUtc,
  zoneForState,
} from "@/lib/shipstation/pickup-requests";

// 2026-11-10 18:00 UTC: 11:00 in Phoenix, 10:00 in Los Angeles, 13:00 in New York.
const NOW = new Date("2026-11-10T18:00:00Z");
const PHOENIX = "America/Phoenix";

const form = (over: Partial<{ date: string; readyTime: string; closeTime: string; notes: string }> = {}) => ({
  date: "2026-11-11",
  readyTime: "09:00",
  closeTime: "17:00",
  notes: "",
  ...over,
});

describe("pickup time zone", () => {
  it("finds the state in a label's ship-from summary", () => {
    expect(stateFromSummary("Desert Diesel Service, 1001 S 7th St, Phoenix AZ 85034")).toBe("AZ");
    expect(stateFromSummary("CDS, 1 Main St, Boston MA 02108")).toBe("MA");
    expect(stateFromSummary(null)).toBeNull();
    expect(stateFromSummary("no address")).toBeNull();
  });

  it("maps a state to its main zone, else the portal's Pacific zone", () => {
    expect(zoneForState("AZ")).toBe(PHOENIX);
    expect(zoneForState("tx")).toBe("America/Chicago");
    expect(zoneForState(null)).toBe(DEFAULT_PICKUP_ZONE);
    expect(zoneForState("ZZ")).toBe(DEFAULT_PICKUP_ZONE);
  });

  it("turns a local time into the right instant, daylight saving included", () => {
    expect(zonedToUtc("2026-11-11", "09:00", PHOENIX).toISOString()).toBe("2026-11-11T16:00:00.000Z");
    expect(zonedToUtc("2026-11-11", "09:00", "America/New_York").toISOString()).toBe("2026-11-11T14:00:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  it("knows today's date at the pickup address", () => {
    expect(todayIn(PHOENIX, new Date("2026-11-11T05:00:00Z"))).toBe("2026-11-10");
    expect(todayIn("America/New_York", new Date("2026-11-11T05:00:00Z"))).toBe("2026-11-11");
  });
});

describe("validatePickupForm", () => {
  it("accepts a future window and returns it as local times and instants", () => {
    const r = validatePickupForm(form({ notes: "  Dock 4,   ring bell " }), PHOENIX, NOW);
    expect(r).toEqual({
      ok: true,
      window: {
        date: "2026-11-11",
        readyTime: "09:00",
        closeTime: "17:00",
        timeZone: PHOENIX,
        startIso: "2026-11-11T16:00:00.000Z",
        endIso: "2026-11-12T00:00:00.000Z",
      },
      notes: "Dock 4, ring bell",
    });
  });

  it("needs a real date and both times", () => {
    expect(validatePickupForm(form({ date: "" }), PHOENIX, NOW)).toEqual({ ok: false, error: "Enter the pickup date." });
    expect(validatePickupForm(form({ date: "2026-02-30" }), PHOENIX, NOW)).toEqual({ ok: false, error: "Enter the pickup date." });
    expect(validatePickupForm(form({ readyTime: "" }), PHOENIX, NOW).ok).toBe(false);
    expect(validatePickupForm(form({ closeTime: "25:00" }), PHOENIX, NOW).ok).toBe(false);
  });

  it("refuses a close time that is not after the ready time", () => {
    for (const closeTime of ["09:00", "08:30"]) {
      expect(validatePickupForm(form({ closeTime }), PHOENIX, NOW)).toEqual({ ok: false, error: "The close time must be after the ready time." });
    }
  });

  it("refuses a date in the past at the pickup address", () => {
    expect(validatePickupForm(form({ date: "2026-11-09" }), PHOENIX, NOW)).toEqual({ ok: false, error: "The pickup date is in the past." });
  });

  it("accepts today while the close time is ahead, not after it", () => {
    expect(validatePickupForm(form({ date: "2026-11-10", readyTime: "12:00", closeTime: "16:00" }), PHOENIX, NOW).ok).toBe(true);
    const late = validatePickupForm(form({ date: "2026-11-10", readyTime: "08:00", closeTime: "10:30" }), PHOENIX, NOW);
    expect(late).toEqual({ ok: false, error: "The close time has already passed today. Pick a later time or date." });
  });

  it("limits the notes for the driver", () => {
    expect(validatePickupForm(form({ notes: "x".repeat(201) }), PHOENIX, NOW).ok).toBe(false);
    const empty = validatePickupForm(form({ notes: "   " }), PHOENIX, NOW);
    expect(empty.ok && empty.notes).toBeNull();
  });
});

describe("pickup contact", () => {
  it("uses the Shipping settings name, email and phone", () => {
    expect(pickupContact({ from_name: " Dispatch ", from_email: "ship@example.com", from_phone: "602-555-0100" })).toEqual({
      ok: true,
      contact: { name: "Dispatch", email: "ship@example.com", phone: "602-555-0100" },
    });
    expect(pickupContact({ from_name: null, from_company: "CDS", from_email: "ship@example.com", from_phone: "1" })).toMatchObject({
      ok: true,
      contact: { name: "CDS" },
    });
  });

  it("says what is missing", () => {
    expect(pickupContact({ from_name: "Dispatch", from_email: "", from_phone: null })).toEqual({
      ok: false,
      error: "Add CDS's email, phone under Shipping settings: the carrier needs a contact for the pickup.",
    });
    expect(pickupContact(null).ok).toBe(false);
    expect(pickupContact({ from_name: "D", from_email: "not-an-email", from_phone: "1" }).ok).toBe(false);
  });
});

describe("buildPickupRequest", () => {
  const checked = validatePickupForm(form({ notes: "Call on arrival" }), PHOENIX, NOW);
  if (!checked.ok) throw new Error("fixture");
  const contact = { name: "Dispatch", email: "ship@example.com", phone: "602-555-0100" };

  it("matches the documented POST /v2/pickups body, with local times and no offset", () => {
    expect(buildPickupRequest({ labelId: "se-28529731", contact, window: checked.window, notes: checked.notes })).toEqual({
      label_ids: ["se-28529731"],
      contact_details: contact,
      pickup_notes: "Call on arrival",
      pickup_window: { start_at: "2026-11-11T09:00:00.000", end_at: "2026-11-11T17:00:00.000" },
    });
  });

  it("leaves out empty notes and needs a label id", () => {
    const body = buildPickupRequest({ labelId: "se-1", contact, window: checked.window, notes: null });
    expect(body).not.toHaveProperty("pickup_notes");
    expect(() => buildPickupRequest({ labelId: " ", contact, window: checked.window, notes: null })).toThrow();
  });
});

describe("mapPickup", () => {
  it("reads the documented answer", () => {
    const body = {
      pickup_id: "pik_3YcKU5zdtJuCqoeNwyqqbW",
      label_ids: ["se-28529731"],
      created_at: "2026-11-10T18:00:05.000Z",
      carrier_id: "se-7157832",
      confirmation_number: "292513CL4A3",
      warehouse_id: "se-1",
      pickup_notes: "Call on arrival",
      pickup_windows: [{ start_at: "2026-11-11T09:00:00.000", end_at: "2026-11-11T17:00:00.000" }],
      request_id: "aa3d8e8e-462b-4476-9618-72db7f7b7009",
      errors: [],
    };
    expect(mapPickup(body)).toEqual({ pickupId: "pik_3YcKU5zdtJuCqoeNwyqqbW", confirmationNumber: "292513CL4A3", carrierId: "se-7157832" });
  });

  it("keeps a missing confirmation number as null", () => {
    expect(mapPickup({ pickup_id: "pik_1", confirmation_number: null }).confirmationNumber).toBeNull();
    expect(mapPickup({ pickup_id: "pik_1", confirmation_number: "  " }).confirmationNumber).toBeNull();
  });

  it("fails without a pickup id, with ShipStation's reason when it gave one", () => {
    expect(() => mapPickup({ errors: [{ message: "carrier_not_supported" }] })).toThrow("ShipStation did not book the pickup: carrier_not_supported");
    expect(() => mapPickup(null)).toThrow("ShipStation did not return the new pickup");
  });
});

describe("test labels", () => {
  it("never book a pickup for a test label or while the portal makes test labels", () => {
    expect(pickupRefusal({ is_test: false }, true)).toBe("Pickups can only be booked for real labels (the portal is making test labels).");
    expect(pickupRefusal({ is_test: true }, false)).toMatch(/this is a test label/);
    expect(pickupRefusal({ is_test: false }, false)).toBeNull();
  });
});

describe("pickupWindowText", () => {
  it("shows the window in the pickup address's zone", () => {
    expect(pickupWindowText("2026-11-11T16:00:00.000Z", "2026-11-12T00:00:00.000Z", PHOENIX)).toBe("Wed, Nov 11, 2026, 9:00 AM to 5:00 PM MST");
    expect(pickupWindowText("bad", "bad", PHOENIX)).toBe("");
  });
});
