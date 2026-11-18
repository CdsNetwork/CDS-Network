/**
 * "Add shipment" on every order, also local pickup ones (Sarah, CDS, 2026-11-18: a local shop
 * cleans a filter, it fails, and CDS ships the customer a replacement). Its help text only
 * points "above" when there is a leg above.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addShipmentHelp, defaultShipmentDirection, noShipmentsNotice } from "@/components/cds-wo/add-shipment";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("add shipment on the work order page", () => {
  it("a pickup order with no legs says none are needed, and that one can still be added", () => {
    const pickup = noShipmentsNotice("pickup");
    expect(pickup).toMatch(/^Affiliate Pickup \/ Local Delivery\./);
    expect(pickup).not.toMatch(/no shipment legs needed/i);
    expect(pickup).toMatch(/add a shipment below/);
    for (const f of ["shipping", "supplier_direct", "unspecified"]) {
      expect(noShipmentsNotice(f)).toBe("No shipment legs yet. Add one below when a tracking number is known.");
    }
  });

  it("the first leg's direction suits the order: CDS ships a replacement on a pickup order", () => {
    expect(defaultShipmentDirection("pickup")).toBe("cds_to_customer");
    expect(defaultShipmentDirection("supplier_direct")).toBe("supplier_to_customer");
    expect(defaultShipmentDirection("shipping")).toBe("customer_to_affiliate");
    expect(defaultShipmentDirection("unspecified")).toBe("customer_to_affiliate");
  });

  it("help text says 'in the leg above' only when legs exist", () => {
    expect(addShipmentHelp(0)).toBe("Add a leg, then get rates and create its label.");
    expect(addShipmentHelp(2)).toBe("Add a leg, then get rates and create its label in the leg above.");
  });

  it("the page offers Add shipment on every order, collapsed, and uses the helpers", () => {
    const wo = source("app/cds/work-orders/[id]/page.tsx");
    expect(wo).not.toMatch(/canAddShipment/);
    expect(wo).toMatch(/<details style=\{\{ marginTop: 14 \}\}>\s*<summary className="link">Add shipment<\/summary>/);
    expect(wo).toMatch(/noShipmentsNotice\(wo\.fulfillment\)/);
    expect(wo).toMatch(/defaultValue=\{defaultShipmentDirection\(wo\.fulfillment\)\}/);
    expect(wo).toMatch(/\{addShipmentHelp\(shipments\.length\)\}/);
    expect(wo).not.toMatch(/create its label above/);
  });
});
