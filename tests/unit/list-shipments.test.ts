/**
 * Shipment carrier status in the CDS work order list (Sarah, CDS, 2026-11-17): each shipment
 * leg of an order with a short direction ("In" to the shop or CDS, "Out" back to the
 * customer, as private.is_return_leg), its status and, when cheap, a tracking link.
 */
import { describe, expect, it } from "vitest";
import { listLegs, type LegRow } from "@/components/cds-wo/list-shipments";

const leg = (over: Partial<LegRow>): LegRow => ({
  id: "s1",
  direction: "customer_to_affiliate",
  status: "in_transit",
  carrier: null,
  tracking_number: null,
  created_at: "2026-11-10T10:00:00Z",
  ...over,
});

describe("shipment legs shown in the list", () => {
  it("shows nothing for an order without shipments", () => {
    expect(listLegs(null)).toEqual([]);
    expect(listLegs([])).toEqual([]);
  });

  it("labels legs In (to the shop or CDS) and Out (to the customer)", () => {
    const dirs = (d: string) => listLegs([leg({ direction: d })])[0].dir;
    expect(dirs("customer_to_affiliate")).toBe("In");
    expect(dirs("customer_to_cds")).toBe("In");
    expect(dirs("affiliate_to_customer")).toBe("Out");
    expect(dirs("cds_to_customer")).toBe("Out");
    expect(dirs("supplier_to_customer")).toBe("Out");
  });

  it("lists In legs before Out legs, oldest first within a direction", () => {
    const legs = listLegs([
      leg({ id: "out", direction: "affiliate_to_customer", created_at: "2026-11-09T00:00:00Z" }),
      leg({ id: "in2", created_at: "2026-11-12T00:00:00Z" }),
      leg({ id: "in1", created_at: "2026-11-11T00:00:00Z" }),
    ]);
    expect(legs.map((l) => l.id)).toEqual(["in1", "in2", "out"]);
  });

  it("keeps the status and describes the leg with the Shipping page's direction label", () => {
    const [l] = listLegs([leg({ status: "exception", carrier: "FedEx", tracking_number: "7777 1234" })]);
    expect(l.status).toBe("exception");
    expect(l.title).toBe("Customer → Affiliate, FedEx 7777 1234");
    expect(l.trackingUrl).toBeNull();
  });

  it("links a UPS tracking number to UPS's tracking page", () => {
    const [l] = listLegs([leg({ carrier: "UPS", tracking_number: "1Z999AA10123456784" })]);
    expect(l.trackingUrl).toBe("https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784");
    expect(l.title).toBe("Customer → Affiliate, UPS 1Z999AA10123456784");
  });

  it("describes a leg without carrier or tracking by its direction only", () => {
    expect(listLegs([leg({})])[0].title).toBe("Customer → Affiliate");
  });
});
