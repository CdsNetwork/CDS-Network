/**
 * CDS (2026-11-10): a shipment on an order with no shop "just kept reading 'the work order has
 * no shop'". The message now says what to do, and the order page shows it on the leg before
 * Get rates is pressed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingLegEnds, NO_LOCATION_PROBLEM, NO_SHOP_PROBLEM } from "@/lib/shipstation/ends";

const none = { affiliateId: null, locationId: null };
const both = { affiliateId: "shop-1", locationId: "loc-1" };

describe("missingLegEnds", () => {
  it("asks for a shop on a leg to or from the shop", () => {
    expect(missingLegEnds("customer_to_affiliate", { affiliateId: null, locationId: "loc-1" })).toEqual([NO_SHOP_PROBLEM]);
    expect(missingLegEnds("affiliate_to_customer", { affiliateId: null, locationId: "loc-1" })).toEqual([NO_SHOP_PROBLEM]);
    expect(NO_SHOP_PROBLEM).toMatch(/^Assign a shop to this work order first/);
  });

  it("asks for the customer location on a leg to or from it", () => {
    expect(missingLegEnds("cds_to_customer", none)).toEqual([NO_LOCATION_PROBLEM]);
    expect(NO_LOCATION_PROBLEM).toMatch(/^Set the customer location on this work order first/);
  });

  it("lists both when both are missing, and nothing when both are set", () => {
    expect(missingLegEnds("customer_to_affiliate", none)).toEqual([NO_SHOP_PROBLEM, NO_LOCATION_PROBLEM]);
    expect(missingLegEnds("customer_to_affiliate", both)).toEqual([]);
    expect(missingLegEnds("unknown_direction", none)).toEqual([]);
  });

  it("is what the label code reports, and what the order page shows", () => {
    const labels = readFileSync("src/lib/shipstation/labels.ts", "utf8");
    expect(labels).toMatch(/problem: NO_SHOP_PROBLEM/);
    expect(labels).toMatch(/problem: NO_LOCATION_PROBLEM/);
    expect(labels).not.toMatch(/The work order has no shop/);
    const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");
    expect(page).toMatch(/missingLegEnds\(s\.direction/);
  });
});
