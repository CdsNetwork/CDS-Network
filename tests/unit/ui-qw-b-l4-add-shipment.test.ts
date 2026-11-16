/**
 * "Add shipment" only on orders that ship (not on local pickup), and its help text only
 * points "above" when there is a leg above.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addShipmentHelp, canAddShipment } from "@/components/cds-wo/add-shipment";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("add shipment on the work order page", () => {
  it("is offered for shipping, supplier direct and unset fulfillment, not for local pickup", () => {
    expect(canAddShipment("shipping")).toBe(true);
    expect(canAddShipment("supplier_direct")).toBe(true);
    expect(canAddShipment("unspecified")).toBe(true);
    expect(canAddShipment("pickup")).toBe(false);
  });

  it("help text says 'in the leg above' only when legs exist", () => {
    expect(addShipmentHelp(0)).toBe("Add a leg, then get rates and create its label.");
    expect(addShipmentHelp(2)).toBe("Add a leg, then get rates and create its label in the leg above.");
  });

  it("the page uses both", () => {
    const wo = source("app/cds/work-orders/[id]/page.tsx");
    expect(wo).toMatch(/canAddShipment\(wo\.fulfillment\) && \(/);
    expect(wo).toMatch(/\{addShipmentHelp\(shipments\.length\)\}/);
    expect(wo).not.toMatch(/create its label above/);
  });
});
