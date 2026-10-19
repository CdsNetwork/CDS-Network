/**
 * BUG-M2-6: a new shipment leg has no label yet, so both "add shipment" forms start at
 * Needs Label, not Label Created or Awaiting Carrier Pickup.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NEW_SHIPMENT_STATUS } from "@/app/cds/shipping/options";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("new shipment status default", () => {
  it("is Needs Label", () => {
    expect(NEW_SHIPMENT_STATUS).toBe("label_needed");
  });

  it("is used by the work order 'Add shipment' form and the shipping page form", () => {
    const wo = source("app/cds/work-orders/[id]/page.tsx");
    const shipping = source("app/cds/shipping/page.tsx");
    expect(wo).not.toMatch(/defaultValue="label_created"/);
    expect(wo).toMatch(/name="status" defaultValue=\{NEW_SHIPMENT_STATUS\}/);
    expect(shipping).not.toMatch(/\?\? "awaiting_pickup"/);
    expect(shipping).toMatch(/defaultValue=\{s\?\.status \?\? NEW_SHIPMENT_STATUS\}/);
  });
});
