import { describe, expect, it } from "vitest";
import { isCustomerItem, lineItemFor, type CustomerItemRef } from "@/lib/customer-items";

const FS = "first-student";
const RYDER = "ryder";
const catalog: CustomerItemRef[] = [
  { id: "g1051", variant_of: null, variant_customer_id: null },
  { id: "g1051am", variant_of: "g1051", variant_customer_id: FS },
  { id: "cl1051", variant_of: null, variant_customer_id: null },
  { id: "cl1051am", variant_of: "cl1051", variant_customer_id: FS, active: false },
  { id: "svc-dpf", variant_of: null, variant_customer_id: null },
];

describe("customer items (First Student AM gaskets and clamps)", () => {
  it("a gasket on a First Student order becomes its AM item", () => {
    expect(lineItemFor("g1051", FS, catalog)).toBe("g1051am");
    expect(lineItemFor("g1051am", FS, catalog)).toBe("g1051am");
  });

  it("on another customer's order the regular item stays, and an AM item becomes the regular one", () => {
    expect(lineItemFor("g1051", RYDER, catalog)).toBe("g1051");
    expect(lineItemFor("g1051am", RYDER, catalog)).toBe("g1051");
    expect(lineItemFor("g1051am", null, catalog)).toBe("g1051");
  });

  it("items without an AM item, and inactive AM items, are not switched", () => {
    expect(lineItemFor("svc-dpf", FS, catalog)).toBe("svc-dpf");
    expect(lineItemFor("cl1051", FS, catalog)).toBe("cl1051");
    expect(lineItemFor("unknown", FS, catalog)).toBe("unknown");
  });

  it("tells customer items apart", () => {
    expect(catalog.filter(isCustomerItem).map((c) => c.id)).toEqual(["g1051am", "cl1051am"]);
  });
});
