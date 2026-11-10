/**
 * Booking and cancelling a carrier pickup: no ShipStation call for a test label or while the
 * portal makes test labels; a real label sends the documented request and records the
 * answer through cds_record_shipment_pickup. fetch is stubbed: nothing reaches ShipStation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integration-sync", () => ({ recordSync: vi.fn(async () => true) }));

const { schedulePickupForLabel, cancelPickup } = await import("@/lib/shipstation/pickups");

const LABEL_ID = "00000000-0000-4000-8000-00000000b001";
const NOW = new Date("2026-11-10T18:00:00Z");
const FORM = { date: "2026-11-11", readyTime: "09:00", closeTime: "17:00", notes: "Dock 4" };

type Rows = { label?: Record<string, unknown> | null; pickup?: Record<string, unknown> | null; scheduled?: number };

function fakeDb(rows: Rows) {
  const rpc = vi.fn(async () => ({ data: "new-id", error: null }));
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => {
        if (table === "shipment_labels") return { data: rows.label ?? null, error: null };
        if (table === "shipment_pickups") return { data: rows.pickup ?? null, error: null };
        if (table === "shipping_settings") {
          return { data: { from_name: "Dispatch", from_company: "CDS", from_email: "ship@example.com", from_phone: "602-555-0100" }, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => void) => resolve({ count: rows.scheduled ?? 0, error: null }),
    };
    return q;
  };
  return { db: { from, rpc } as never, rpc };
}

const realLabel = {
  id: LABEL_ID,
  shipment_id: "00000000-0000-4000-8000-00000000c001",
  shipstation_label_id: "se-28529731",
  is_test: false,
  status: "active",
  ship_from_summary: "Desert Diesel Service, 1001 S 7th St, Phoenix AZ 85034",
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SHIPSTATION_API_KEY", "TEST_key");
  vi.stubEnv("SHIPSTATION_TEST_LABELS", "false");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("schedulePickupForLabel", () => {
  it("does not call ShipStation while the portal makes test labels", async () => {
    vi.stubEnv("SHIPSTATION_TEST_LABELS", "true");
    const { db, rpc } = fakeDb({ label: realLabel });
    const r = await schedulePickupForLabel(db, LABEL_ID, FORM, NOW);
    expect(r).toEqual({ ok: false, error: "Pickups can only be booked for real labels (the portal is making test labels)." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not call ShipStation for a test label", async () => {
    const { db } = fakeDb({ label: { ...realLabel, is_test: true } });
    const r = await schedulePickupForLabel(db, LABEL_ID, FORM, NOW);
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a second pickup on the same label and a bad window before calling ShipStation", async () => {
    expect((await schedulePickupForLabel(fakeDb({ label: realLabel, scheduled: 1 }).db, LABEL_ID, FORM, NOW)).ok).toBe(false);
    const bad = await schedulePickupForLabel(fakeDb({ label: realLabel }).db, LABEL_ID, { ...FORM, closeTime: "08:00" }, NOW);
    expect(bad).toEqual({ ok: false, error: "The close time must be after the ready time." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("books a real label's pickup and records it", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ pickup_id: "pik_1", carrier_id: "se-7157832", confirmation_number: "292513CL4A3", errors: [] }), { status: 200 }),
    );
    const { db, rpc } = fakeDb({ label: realLabel });
    const r = await schedulePickupForLabel(db, LABEL_ID, FORM, NOW);
    expect(r).toEqual({ ok: true, message: "Pickup booked: Wed, Nov 11, 2026, 9:00 AM to 5:00 PM MST, confirmation 292513CL4A3." });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.shipstation.com/v2/pickups");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      label_ids: ["se-28529731"],
      contact_details: { name: "Dispatch", email: "ship@example.com", phone: "602-555-0100" },
      pickup_notes: "Dock 4",
      pickup_window: { start_at: "2026-11-11T09:00:00.000", end_at: "2026-11-11T17:00:00.000" },
    });
    expect(rpc).toHaveBeenCalledWith("cds_record_shipment_pickup", {
      p_label: LABEL_ID,
      p_pickup: {
        shipstation_pickup_id: "pik_1",
        confirmation_number: "292513CL4A3",
        window_start: "2026-11-11T16:00:00.000Z",
        window_end: "2026-11-12T00:00:00.000Z",
        time_zone: "America/Phoenix",
        notes: "Dock 4",
      },
    });
  });

  it("shows ShipStation's refusal plainly and records nothing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ request_id: "r1", errors: [{ message: "The carrier does not support pickups." }] }), { status: 400 }),
    );
    const { db, rpc } = fakeDb({ label: realLabel });
    const r = await schedulePickupForLabel(db, LABEL_ID, FORM, NOW);
    expect(r).toEqual({ ok: false, error: "ShipStation refused the pickup: The carrier does not support pickups." });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("cancelPickup", () => {
  it("cancels in ShipStation, then in the portal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ pickup_id: "pik_1" }), { status: 200 }));
    const { db, rpc } = fakeDb({ pickup: { id: "p1", shipment_id: "s1", shipstation_pickup_id: "pik_1", status: "scheduled" } });
    expect(await cancelPickup(db, "p1")).toEqual({ ok: true, message: "Pickup cancelled." });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.shipstation.com/v2/pickups/pik_1");
    expect(init.method).toBe("DELETE");
    expect(rpc).toHaveBeenCalledWith("cds_cancel_shipment_pickup", { p_pickup: "p1" });
  });

  it("keeps the pickup when ShipStation refuses", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Too close to the pickup window." }] }), { status: 400 }));
    const { db, rpc } = fakeDb({ pickup: { id: "p1", shipment_id: "s1", shipstation_pickup_id: "pik_1", status: "scheduled" } });
    expect(await cancelPickup(db, "p1")).toEqual({ ok: false, error: "ShipStation could not cancel the pickup: Too close to the pickup window." });
    expect(rpc).not.toHaveBeenCalled();
  });
});
