/**
 * A label or a pickup is bought only after the portal has reserved the operation
 * (public.cds_claim_shipstation, 20261116030000_shipstation_claims.sql). Two requests at the
 * same time (a double click, two people on the same order) buy exactly one label or book
 * exactly one pickup; the other is refused before ShipStation is called. The claim is released
 * after the purchase is recorded and after a clear refusal, and kept (until it expires) when
 * ShipStation did not answer clearly, so a quick retry cannot buy a second one.
 *
 * The ShipStation client and the database are stubbed: nothing reaches ShipStation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integration-sync", () => ({ recordSync: vi.fn(async () => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } }) }));
const shipStationRequest = vi.fn();
vi.mock("@/lib/shipstation/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shipstation/client")>()),
  shipStationRequest: (...args: unknown[]) => shipStationRequest(...args),
}));

const { createLabelForShipment } = await import("@/lib/shipstation/labels");
const { schedulePickupForLabel } = await import("@/lib/shipstation/pickups");
const { ShipStationError } = await import("@/lib/shipstation/client");

const SHIPMENT = "00000000-0000-4000-8000-00000000c001";
const LABEL_ID = "00000000-0000-4000-8000-00000000b001";
const CHOICE = { carrierId: "se-7157769", serviceCode: "usps_ground_advantage", rateId: "se-rate-1", quotedTotal: 9.5, deliveryDays: 3 };
const LABEL = { label_id: "se-1", shipment_id: "se-ship-1", tracking_number: "9400", shipment_cost: { amount: 9.5, currency: "usd" } };
const NOW = new Date("2026-11-10T18:00:00Z");
const FORM = { date: "2026-11-11", readyTime: "09:00", closeTime: "17:00", notes: "" };

/**
 * The database as the app sees it: reads for one shipment leg and one real label, and the
 * claim functions with the same rule as the migration (one live claim per operation).
 */
function fakeDb() {
  const claims = new Map<string, string>();
  let next = 0;
  const recorded: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "cds_claim_shipstation") {
      const key = `${args.p_kind}:${args.p_target}`;
      if (claims.has(key)) {
        const message =
          args.p_kind === "label"
            ? "A label is already being created for this shipment. Refresh in a moment."
            : "A pickup is already being booked for this label. Refresh in a moment.";
        return { data: null, error: { code: "P0001", message } };
      }
      next += 1;
      const id = `00000000-0000-4000-8000-0000000c1a1${next}`;
      claims.set(key, id);
      return { data: id, error: null };
    }
    if (name === "cds_release_shipstation") {
      const key = `${args.p_kind}:${args.p_target}`;
      if (claims.get(key) === args.p_claim) claims.delete(key);
      return { data: null, error: null };
    }
    recorded.push(name);
    return { data: "row-id", error: null };
  });
  const from = (table: string) => {
    const result = (): unknown => {
      if (table === "shipments") {
        return {
          id: SHIPMENT,
          work_order_id: "wo-1",
          direction: "affiliate_to_customer",
          weight_lb: 2,
          length_in: null,
          width_in: null,
          height_in: null,
          work_orders: {
            id: "wo-1",
            wo_number: 101900,
            status: "completed",
            location_label: "Highland",
            location_id: "loc-1",
            affiliate_id: "shop-1",
            customers: { name: "First Student" },
            customer_locations: { default_affiliate_id: null },
          },
        };
      }
      if (table === "affiliates") {
        return { display_name: "Akron Diesel", active: true, address_line1: "9 Shop Rd", city: "Akron", region: "OH", postal_code: "44301", country: "US" };
      }
      if (table === "customer_locations") {
        return { name: "Highland", address_line1: "1 Bus Way", city: "Highland", region: "IL", postal_code: "62249", country: "US" };
      }
      if (table === "shipping_settings") {
        return {
          from_name: "Dispatch",
          from_company: "CDS",
          from_phone: "602-555-0100",
          from_email: "ship@example.com",
          address_line1: "1 CDS Way",
          city: "Phoenix",
          region: "AZ",
          postal_code: "85034",
          country: "US",
          default_weight_lb: 45,
        };
      }
      if (table === "shipment_labels") {
        return {
          id: LABEL_ID,
          shipment_id: SHIPMENT,
          shipstation_label_id: "se-28529731",
          shipstation_carrier_id: "se-7157832",
          is_test: false,
          status: "active",
          ship_from_summary: "Desert Diesel Service, 1001 S 7th St, Phoenix AZ 85034",
        };
      }
      if (table === "shipping_carriers") return { name: "FedEx", api_pickups: true };
      return null;
    };
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: result(), error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (table === "shipping_carriers") {
          return resolve({ data: [{ shipstation_carrier_id: "se-7157769", carrier: "USPS", name: "USPS", active: true, shipping_services: [] }], error: null });
        }
        return resolve({ data: null, count: 0, error: null });
      },
    };
    return q;
  };
  return { db: { from, rpc } as never, rpc, claims, recorded };
}

/** ShipStation answers after both requests have started. */
function slowly<T>(value: T) {
  return () => new Promise<T>((resolve) => setTimeout(() => resolve(value), 20));
}

beforeEach(() => {
  shipStationRequest.mockReset();
  vi.stubEnv("SHIPSTATION_API_KEY", "TEST_key");
  vi.stubEnv("SHIPSTATION_TEST_LABELS", "false");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createLabelForShipment at the same time twice", () => {
  it("buys exactly one label and refuses the other before calling ShipStation", async () => {
    shipStationRequest.mockImplementation(slowly(LABEL));
    const { db, claims, recorded } = fakeDb();
    const results = await Promise.all([createLabelForShipment(db, SHIPMENT, CHOICE), createLabelForShipment(db, SHIPMENT, CHOICE)]);
    expect(shipStationRequest).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "A label is already being created for this shipment. Refresh in a moment." });
    expect(recorded).toEqual(["cds_record_shipment_label"]);
    // Released once recorded: the record function and the active label guard the next try.
    expect(claims.size).toBe(0);
  });

  it("uses the claim as the external shipment id", async () => {
    shipStationRequest.mockImplementation(slowly(LABEL));
    const { db, rpc } = fakeDb();
    await createLabelForShipment(db, SHIPMENT, CHOICE);
    const claim = (await rpc.mock.results[0].value) as { data: string };
    const [, , , opts] = shipStationRequest.mock.calls[0] as [string, string, string, { body: { shipment: { external_shipment_id: string } } }];
    expect(opts.body.shipment.external_shipment_id).toBe(`${SHIPMENT}-${claim.data}`);
  });

  it("releases the claim when ShipStation refuses, so CDS can try again", async () => {
    shipStationRequest.mockRejectedValue(new ShipStationError("Invalid address", 400));
    const { db, claims } = fakeDb();
    const r = await createLabelForShipment(db, SHIPMENT, CHOICE);
    expect(r.ok).toBe(false);
    expect(claims.size).toBe(0);
  });

  it("keeps the claim when ShipStation did not answer clearly, so a quick retry cannot buy a second label", async () => {
    shipStationRequest.mockRejectedValue(new ShipStationError("timed out", 0));
    const { db, claims } = fakeDb();
    const first = await createLabelForShipment(db, SHIPMENT, CHOICE);
    expect(!first.ok && first.error).toMatch(/did not answer clearly/);
    expect(claims.size).toBe(1);
    const retry = await createLabelForShipment(db, SHIPMENT, CHOICE);
    expect(retry).toEqual({ ok: false, error: "A label is already being created for this shipment. Refresh in a moment." });
    expect(shipStationRequest).toHaveBeenCalledTimes(1);
  });
});

describe("schedulePickupForLabel at the same time twice", () => {
  it("books exactly one pickup and refuses the other before calling ShipStation", async () => {
    shipStationRequest.mockImplementation(slowly({ pickup_id: "pik_1", confirmation_number: "C1", errors: [] }));
    const { db, claims, recorded } = fakeDb();
    const results = await Promise.all([schedulePickupForLabel(db, LABEL_ID, FORM, NOW), schedulePickupForLabel(db, LABEL_ID, FORM, NOW)]);
    expect(shipStationRequest).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "A pickup is already being booked for this label. Refresh in a moment." });
    expect(recorded).toEqual(["cds_record_shipment_pickup"]);
    expect(claims.size).toBe(0);
  });

  it("releases the claim when ShipStation refuses", async () => {
    shipStationRequest.mockRejectedValue(new ShipStationError("No pickups on Sunday", 400));
    const { db, claims } = fakeDb();
    expect((await schedulePickupForLabel(db, LABEL_ID, FORM, NOW)).ok).toBe(false);
    expect(claims.size).toBe(0);
  });
});
