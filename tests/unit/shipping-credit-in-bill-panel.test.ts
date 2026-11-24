/**
 * "Shipping credit from shop" in the shop bill approval box too (Sarah, CDS, 2026-11-24): CDS
 * checks the shop's bill in the Shop bill box before "Approve and send to QuickBooks" and wants
 * to turn the credit off there, without scrolling back to the lines. The same checkbox (same
 * action setShopShippingCredit, same locks, never for the in-house shop) shows right above the
 * approve button while the bill waits for approval; the one under the lines stays. Both forms
 * render from the saved value and are keyed by it, so after a save (the action revalidates the
 * page) both show what was saved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BillState } from "@/lib/qbo/bill";
import { shippingCreditInBillPanel } from "@/lib/shop-deductions";

const pending = {
  kind: "pending_approval",
  payload: { DocNumber: "INV-1", VendorRef: { value: "1" }, Line: [] },
  total: 100,
} as unknown as BillState;
const regular = { qbBillId: null, inHouse: false, hasShop: true, hasInternal: true };

describe("shippingCreditInBillPanel", () => {
  it("shows while the bill waits for CDS's approval, for a regular shop", () => {
    expect(shippingCreditInBillPanel(pending, regular)).toBe(true);
  });

  it("not for the in-house shop, an order without a shop, or without its CDS row", () => {
    expect(shippingCreditInBillPanel(pending, { ...regular, inHouse: true })).toBe(false);
    expect(shippingCreditInBillPanel(pending, { ...regular, hasShop: false })).toBe(false);
    expect(shippingCreditInBillPanel(pending, { ...regular, hasInternal: false })).toBe(false);
  });

  it("not once the bill is in QuickBooks (either record) or being created, nor before it waits for approval", () => {
    expect(shippingCreditInBillPanel(pending, { ...regular, qbBillId: "QB-9" })).toBe(false);
    expect(shippingCreditInBillPanel({ kind: "creating" }, regular)).toBe(false);
    expect(
      shippingCreditInBillPanel({ kind: "created", billId: "9", number: null, total: null, at: null, changedTotal: null, division: null }, regular),
    ).toBe(false);
    expect(shippingCreditInBillPanel({ kind: "none" }, regular)).toBe(false);
    expect(shippingCreditInBillPanel({ kind: "blocked", problems: ["x"], lastError: null }, regular)).toBe(false);
    expect(shippingCreditInBillPanel(null, regular)).toBe(false);
  });

  it("not after approval (the bill is being sent or retried)", () => {
    const ready = { ...(pending as object), kind: "ready", approvedAt: "2026-11-24T10:00:00Z" } as unknown as BillState;
    expect(shippingCreditInBillPanel(ready, regular)).toBe(false);
  });
});

describe("wiring", () => {
  const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

  it("the Shop bill box renders the shared checkbox above the approve button", () => {
    const panel = src("components/cds-wo/ShopBillPanel.tsx");
    expect(panel).toMatch(/<ShippingCreditForm/);
    expect(panel.indexOf("<ShippingCreditForm")).toBeLessThan(panel.indexOf(`submitLabel="Approve and send to QuickBooks"`));
  });

  it("the shared checkbox saves with setShopShippingCredit and is keyed by the saved value", () => {
    const form = src("components/cds-wo/ShippingCreditForm.tsx");
    expect(form).toMatch(/setShopShippingCredit\.bind\(null, woId\)/);
    expect(form).toMatch(/key=\{/);
    expect(form).toMatch(/SHIPPING_CREDIT_HELP/);
  });

  it("the work order page keeps the checkbox under the lines and passes the value to the Shop bill box", () => {
    const page = src("app/cds/work-orders/[id]/page.tsx");
    expect(page.match(/<ShippingCreditForm/g)?.length).toBe(1);
    expect(page).toMatch(/shippingCreditInBillPanel\(shopBill,/);
    expect(page).toMatch(/<ShopBillPanel[^>]*shippingCredit=/);
  });
});
