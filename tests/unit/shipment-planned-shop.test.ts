/**
 * CDS (2026-11-10): "they usually prep the shipping label before they dispatch it". While a work
 * order is in review it has no shop yet, so rates and labels for legs to or from the shop use the
 * planned shop: the shop Review & Dispatch offers by default (the order's shop after Send back
 * to review, else the location's default shop). The label records the shop it was made for, and
 * the work order page warns when the order went to another shop. Dispatch is never blocked.
 *
 * The ShipStation client is stubbed: nothing reaches ShipStation.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integration-sync", () => ({ recordSync: vi.fn(async () => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } }) }));
const shipStationRequest = vi.fn();
vi.mock("@/lib/shipstation/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shipstation/client")>()),
  shipStationRequest: (...args: unknown[]) => shipStationRequest(...args),
}));

const { labelShop, labelShopMismatch, missingLegEnds, NO_SHOP_PROBLEM, shopEnd } = await import("@/lib/shipstation/ends");
const { createLabelForShipment, ratesForShipment } = await import("@/lib/shipstation/labels");

const AKRON = "11111111-1111-4111-8111-111111111111";
const ENVIROMOTIVE = "22222222-2222-4222-8222-222222222222";
const SHIPMENT = "00000000-0000-4000-8000-00000000c001";

describe("labelShop (the shop a label is addressed to)", () => {
  it("is the location's default shop, planned, for a new order in review", () => {
    expect(labelShop({ status: "pending_review", affiliateId: null, locationDefault: AKRON })).toEqual({ affiliateId: AKRON, planned: true });
  });

  it("is the order's shop, planned, after Send back to review", () => {
    expect(labelShop({ status: "pending_review", affiliateId: ENVIROMOTIVE, locationDefault: AKRON })).toEqual({ affiliateId: ENVIROMOTIVE, planned: true });
  });

  it("is never the shop that declined", () => {
    expect(labelShop({ status: "rejected_by_affiliate", affiliateId: ENVIROMOTIVE, locationDefault: AKRON })).toEqual({ affiliateId: AKRON, planned: true });
    expect(labelShop({ status: "rejected_by_affiliate", affiliateId: AKRON, locationDefault: AKRON })).toBeNull();
  });

  it("is none in review without a location default (CDS keeps seeing Assign a shop)", () => {
    expect(labelShop({ status: "pending_review", affiliateId: null, locationDefault: null })).toBeNull();
    expect(missingLegEnds("customer_to_affiliate", { affiliateId: null, locationId: "loc-1" })).toEqual([NO_SHOP_PROBLEM]);
  });

  it("is the order's shop once dispatched, whatever the location default", () => {
    for (const status of ["dispatched", "accepted", "in_progress", "completed"]) {
      expect(labelShop({ status, affiliateId: ENVIROMOTIVE, locationDefault: AKRON })).toEqual({ affiliateId: ENVIROMOTIVE, planned: false });
    }
    expect(labelShop({ status: "dispatched", affiliateId: null, locationDefault: AKRON })).toBeNull();
  });

  it("knows which end of a leg is the shop", () => {
    expect(shopEnd("customer_to_affiliate")).toBe("to");
    expect(shopEnd("affiliate_to_customer")).toBe("from");
    expect(shopEnd("supplier_to_customer")).toBe("from");
    expect(shopEnd("cds_to_customer")).toBeNull();
    expect(shopEnd("customer_to_cds")).toBeNull();
  });
});

describe("labelShopMismatch", () => {
  const label = { shopId: AKRON, shopName: "Akron Diesel" };

  it("warns when the order went to another shop than the label was made for", () => {
    expect(labelShopMismatch(label, { shop: { affiliateId: ENVIROMOTIVE, planned: false }, shopName: "Enviromotive" })).toBe(
      "The shipping label was made for Akron Diesel, but the order went to Enviromotive. Void it and make a new one.",
    );
  });

  it("warns when the planned shop changed before dispatch, and when no shop is left", () => {
    expect(labelShopMismatch(label, { shop: { affiliateId: ENVIROMOTIVE, planned: true }, shopName: "Enviromotive" })).toMatch(
      /made for Akron Diesel, but the planned shop is now Enviromotive\. Void it and make a new one\.$/,
    );
    expect(labelShopMismatch(label, { shop: null, shopName: null })).toMatch(/made for Akron Diesel, but no shop is picked/);
  });

  it("says nothing when the shop matches, planned or dispatched", () => {
    expect(labelShopMismatch(label, { shop: { affiliateId: AKRON, planned: true }, shopName: "Akron Diesel" })).toBeNull();
    expect(labelShopMismatch(label, { shop: { affiliateId: AKRON, planned: false }, shopName: "Akron Diesel" })).toBeNull();
  });

  it("says nothing for labels without a recorded shop (CDS legs, older labels)", () => {
    expect(labelShopMismatch({ shopId: null, shopName: null }, { shop: { affiliateId: ENVIROMOTIVE, planned: false }, shopName: "Enviromotive" })).toBeNull();
  });
});

// ---------------------------------------------------------------- label flow (stubbed ShipStation)

type Wo = { status: string; affiliate_id: string | null; default_affiliate_id: string | null };
type Shop = { id: string; display_name: string; active: boolean };

const SHOPS: Shop[] = [
  { id: AKRON, display_name: "Akron Diesel", active: true },
  { id: ENVIROMOTIVE, display_name: "Enviromotive", active: true },
];

function fakeDb(wo: Wo, shops: Shop[] = SHOPS) {
  const rpc = vi.fn(async () => ({ data: "label-row-id", error: null }));
  const shopQueries: string[] = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const result = (): unknown => {
      if (table === "shipments") {
        return {
          id: SHIPMENT,
          work_order_id: "wo-1",
          direction: "customer_to_affiliate",
          weight_lb: 2,
          length_in: null,
          width_in: null,
          height_in: null,
          work_orders: {
            id: "wo-1",
            wo_number: 101900,
            status: wo.status,
            location_label: "First Student Highland",
            location_id: "loc-1",
            affiliate_id: wo.affiliate_id,
            customers: { name: "First Student" },
            customer_locations: { default_affiliate_id: wo.default_affiliate_id },
          },
        };
      }
      if (table === "customer_locations") {
        return { name: "Highland", address_line1: "1 Bus Way", city: "Highland", region: "IL", postal_code: "62249", country: "US" };
      }
      if (table === "affiliates") {
        shopQueries.push(String(filters.id));
        const s = shops.find((x) => x.id === filters.id);
        return s ? { display_name: s.display_name, active: s.active, address_line1: "9 Shop Rd", city: "Akron", region: "OH", postal_code: "44301", country: "US" } : null;
      }
      if (table === "shipping_settings") {
        return { from_name: "Dispatch", from_company: "CDS", from_phone: "602-555-0100", from_email: null, address_line1: "1 CDS Way", city: "Phoenix", region: "AZ", postal_code: "85034", country: "US", default_weight_lb: 45 };
      }
      return null;
    };
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        filters[col] = v;
        return q;
      },
      order: () => q,
      maybeSingle: async () => ({ data: result(), error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (table === "shipping_carriers") {
          return resolve({
            data: [{ shipstation_carrier_id: "se-7157769", carrier: "USPS", name: "USPS", active: true, shipping_services: [] }],
            error: null,
          });
        }
        return resolve({ data: null, count: 0, error: null });
      },
    };
    return q;
  };
  return { db: { from, rpc } as never, rpc, shopQueries };
}

const RATES = {
  rate_response: {
    rates: [{ rate_id: "se-rate-1", carrier_id: "se-7157769", carrier_code: "stamps_com", service_code: "usps_ground_advantage", service_type: "Ground", shipping_amount: { amount: 9.5 } }],
  },
};
const LABEL = { label_id: "se-test-1", shipment_id: "se-ship-1", tracking_number: "9400", shipment_cost: { amount: 0, currency: "usd" } };
const CHOICE = { carrierId: "se-7157769", serviceCode: "usps_ground_advantage", rateId: "se-rate-1", quotedTotal: 9.5, deliveryDays: 3 };

beforeEach(() => {
  shipStationRequest.mockReset();
  vi.stubEnv("SHIPSTATION_API_KEY", "TEST_key");
  vi.stubEnv("SHIPSTATION_TEST_LABELS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rates and labels before dispatch", () => {
  it("quotes a leg to the shop of an order in review to the location's default shop", async () => {
    shipStationRequest.mockResolvedValueOnce(RATES);
    const { db, shopQueries } = fakeDb({ status: "pending_review", affiliate_id: null, default_affiliate_id: AKRON });
    const r = await ratesForShipment(db, SHIPMENT);
    expect(r.ok).toBe(true);
    expect(r.ok && r.to).toMatch(/^Akron Diesel, 9 Shop Rd/);
    expect(shopQueries).toEqual([AKRON]);
    const [, method, path, opts] = shipStationRequest.mock.calls[0] as [string, string, string, { body: { shipment: { ship_to: { company_name: string } } } }];
    expect([method, path]).toEqual(["POST", "rates"]);
    expect(opts.body.shipment.ship_to.company_name).toBe("Akron Diesel");
  });

  it("makes the label for the planned shop and records that shop on it (test label)", async () => {
    shipStationRequest.mockResolvedValueOnce(LABEL);
    const { db, rpc } = fakeDb({ status: "pending_review", affiliate_id: null, default_affiliate_id: AKRON });
    const r = await createLabelForShipment(db, SHIPMENT, CHOICE);
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/^Test label created/) });
    const [, , path, opts] = shipStationRequest.mock.calls[0] as [string, string, string, { body: { test_label: boolean; shipment: { ship_to: { company_name: string } } } }];
    expect(path).toBe("labels");
    expect(opts.body.test_label).toBe(true);
    expect(opts.body.shipment.ship_to.company_name).toBe("Akron Diesel");
    expect(rpc).toHaveBeenCalledWith("cds_record_shipment_label", expect.objectContaining({ p_label: expect.objectContaining({ shop_affiliate_id: AKRON, is_test: true }) }));
  });

  it("uses the order's shop after Send back to review, not the location default", async () => {
    shipStationRequest.mockResolvedValueOnce(LABEL);
    const { db, rpc } = fakeDb({ status: "pending_review", affiliate_id: ENVIROMOTIVE, default_affiliate_id: AKRON });
    expect((await createLabelForShipment(db, SHIPMENT, CHOICE)).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("cds_record_shipment_label", expect.objectContaining({ p_label: expect.objectContaining({ shop_affiliate_id: ENVIROMOTIVE }) }));
  });

  it("still asks for a shop when the location has no default shop, without calling ShipStation", async () => {
    const { db, rpc } = fakeDb({ status: "pending_review", affiliate_id: null, default_affiliate_id: null });
    const r = await createLabelForShipment(db, SHIPMENT, CHOICE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(NO_SHOP_PROBLEM);
    expect(shipStationRequest).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not plan a label to a shop that is no longer active", async () => {
    const { db } = fakeDb({ status: "pending_review", affiliate_id: null, default_affiliate_id: AKRON }, [{ id: AKRON, display_name: "Akron Diesel", active: false }]);
    const r = await ratesForShipment(db, SHIPMENT);
    expect(!r.ok && r.error).toContain(NO_SHOP_PROBLEM);
    expect(shipStationRequest).not.toHaveBeenCalled();
  });

  it("after dispatch uses the order's shop as before and records it", async () => {
    shipStationRequest.mockResolvedValueOnce(LABEL);
    const { db, rpc, shopQueries } = fakeDb({ status: "dispatched", affiliate_id: ENVIROMOTIVE, default_affiliate_id: AKRON });
    expect((await createLabelForShipment(db, SHIPMENT, CHOICE)).ok).toBe(true);
    expect(shopQueries).toEqual([ENVIROMOTIVE]);
    expect(rpc).toHaveBeenCalledWith("cds_record_shipment_label", expect.objectContaining({ p_label: expect.objectContaining({ shop_affiliate_id: ENVIROMOTIVE }) }));
  });
});

describe("work order page", () => {
  const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");

  it("checks legs against the label shop (planned in review), shows it, and warns on a mismatch", () => {
    expect(page).toMatch(/labelShop\(\{ status: wo\.status, affiliateId: wo\.affiliate_id, locationDefault \}\)/);
    expect(page).toMatch(/missingLegEnds\(s\.direction, \{ affiliateId: labelShopNow\?\.affiliateId/);
    expect(page).toContain("(planned, not yet dispatched)");
    expect(page).toMatch(/labelShopMismatch\(/);
  });
});
