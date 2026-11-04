/**
 * After "Send back to review", the Shop box on the work order offered the location's default
 * shop instead of the shop the order was with, so one click on Approve & Dispatch moved the
 * job to another shop (WO 101659: Akron offered, order was with Enviromotive). The order's
 * current shop comes first; after a decline the declining shop is never offered by default.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dispatchShopDefault } from "@/components/cds-wo/util";

const AKRON = "11111111-1111-4111-8111-111111111111";
const ENVIROMOTIVE = "22222222-2222-4222-8222-222222222222";

describe("dispatchShopDefault", () => {
  it("keeps the shop the order was with after Send back to review", () => {
    expect(dispatchShopDefault({ status: "pending_review", affiliateId: ENVIROMOTIVE, locationDefault: AKRON })).toBe(ENVIROMOTIVE);
  });

  it("offers the location default for a new draft with no shop", () => {
    expect(dispatchShopDefault({ status: "pending_review", affiliateId: null, locationDefault: AKRON })).toBe(AKRON);
  });

  it("does not offer the shop that declined; falls back to the location default", () => {
    expect(dispatchShopDefault({ status: "rejected_by_affiliate", affiliateId: ENVIROMOTIVE, locationDefault: AKRON })).toBe(AKRON);
  });

  it("offers nothing when the declining shop is also the location default", () => {
    expect(dispatchShopDefault({ status: "rejected_by_affiliate", affiliateId: AKRON, locationDefault: AKRON })).toBe("");
  });

  it("offers nothing when there is no shop and no location default", () => {
    expect(dispatchShopDefault({ status: "pending_review", affiliateId: null, locationDefault: null })).toBe("");
  });
});

describe("work order page", () => {
  const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");

  it("uses dispatchShopDefault for the Shop box", () => {
    expect(page).toMatch(/dispatchShopDefault\(/);
    expect(page).not.toMatch(/location\?\.default_affiliate_id \?\? wo\.affiliate_id/);
  });

  it("marks the order's current shop in the list", () => {
    expect(page).toContain("(current shop)");
  });
});
