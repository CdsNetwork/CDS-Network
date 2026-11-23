/**
 * CDS's in-house shop gets a QuickBooks bill once it is linked to a vendor (Ashley, CDS,
 * 2026-11-19: "CDS In-House shop: we use this exclusively for filter sales via our vendor
 * GESi ... can we link our vendor to this shop in the portal so that when we process the bill
 * it automates and pushes to QBO?").
 *
 *   * Not linked: no bill and no error, as before.
 *   * Linked: the same bill as any shop (items, class, Net 30, custom fields), its lines at the
 *     amounts the order already shows for in-house lines (CDS cost, the line's shop rate), and
 *     no shipping deduction (the deduction view never has one for the in-house shop).
 *   * Orders completed before the vendor was linked are flagged (CDS may have entered those
 *     GESi bills by hand). Since 2026-11-23 no bill is sent without CDS's approval
 *     (shop-bill-approval.test.ts), so the flag only adds a warning.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { billState, type BillInputs, type BillRecord } from "@/lib/qbo/bill";
import { runShopBill, type BillRunDeps } from "@/lib/qbo/bill-run";
import { vendorLinkShops } from "@/lib/qbo/bill-shops";
import { shopPayable } from "@/lib/shop-deductions";

const FILTER = "aaaaaaaa-0000-4000-8000-000000000010";
const GASKET = "aaaaaaaa-0000-4000-8000-000000000011";
const none: BillRecord | null = null;

/** An in-house GESi filter sale: two filters at CDS cost 410.00, one gasket at 6.50. */
function inHouse(over: Partial<BillInputs> = {}, wo: Partial<BillInputs["workOrder"]> = {}): BillInputs {
  return {
    workOrder: {
      id: "22222222-2222-4222-8222-222222222222",
      woNumber: 104500,
      status: "completed",
      completedAt: "2026-11-21T18:00:00Z",
      shopInvoiceRef: "IN-HOUSE-104500",
      customerId: "cccccccc-0000-4000-8000-000000000002",
      customerName: "Penske",
      poNumber: "PO-88",
      unitNumber: "T-12",
      shopName: "CDS Inc (in-house)",
      shopInHouse: true,
      ...wo,
    },
    lines: [
      { catalogItemId: FILTER, sku: "GESI-DPF-1", name: "GESi DPF", description: null, qty: 2, shopUnitRate: 410 },
      { catalogItemId: GASKET, sku: "GSK-1", name: "Gasket", description: null, qty: 1, shopUnitRate: 6.5 },
    ],
    // public.work_order_shop_deductions never has a row for the in-house shop.
    deductions: [],
    vendor: { qboVendorId: "777", qboVendorName: "GESi", linkedAt: "2026-11-20T00:00:00Z" },
    setting: { deduction: { kind: "account", id: "88", name: "Freight Savings" }, termsId: null, termsName: null, since: "2026-11-18T00:00:00Z" },
    classId: "12",
    division: null,
    incomeDivisionName: null,
    itemMap: {
      customer: {},
      default: { [FILTER]: { qboItemId: "620", qboItemName: "GESi DPF" }, [GASKET]: { qboItemId: "610", qboItemName: "Gasket" } },
      otherCustomers: {},
    },
    ...over,
  };
}

describe("in-house orders without a linked vendor: as before", () => {
  it("no bill, no error, nothing runs", () => {
    const s = billState(inHouse({ vendor: null }), none);
    expect(s.kind).toBe("none");
  });

  it("an order with no shop at all still gets no bill", () => {
    const s = billState(inHouse({ vendor: null }, { shopName: "The shop" }), none);
    expect(s.kind).toBe("none");
  });
});

describe("in-house orders with a linked vendor", () => {
  it("are billed like any shop's, at the CDS cost amounts the order shows, with no shipping deduction", () => {
    const i = inHouse();
    const s = billState(i, none);
    if (s.kind !== "pending_approval") throw new Error(`expected pending_approval, got ${s.kind}`);
    const cdsCost = shopPayable(
      i.lines.map((l) => ({ qty: l.qty, shop_unit_rate: l.shopUnitRate })),
      i.deductions,
    );
    expect(cdsCost).toBe(826.5);
    expect(s.total).toBe(cdsCost);
    expect(s.payload.VendorRef).toEqual({ value: "777", name: "GESi" });
    expect(s.payload.DocNumber).toBe("IN-HOUSE-104500");
    expect(s.payload.TxnDate).toBe("2026-11-21");
    expect(s.payload.PrivateNote).toMatch(/^Portal WO-104500 \| Shop invoice IN-HOUSE-104500 \| Penske/);
    expect(s.payload.Line).toEqual([
      {
        DetailType: "ItemBasedExpenseLineDetail",
        Amount: 820,
        Description: "GESI-DPF-1 GESi DPF (2 x $410.00)",
        ItemBasedExpenseLineDetail: { ItemRef: { value: "620", name: "GESi DPF" }, Qty: 2, UnitPrice: 410, ClassRef: { value: "12" }, BillableStatus: "NotBillable" },
      },
      {
        DetailType: "ItemBasedExpenseLineDetail",
        Amount: 6.5,
        Description: "GSK-1 Gasket (1 x $6.50)",
        ItemBasedExpenseLineDetail: { ItemRef: { value: "610", name: "Gasket" }, Qty: 1, UnitPrice: 6.5, ClassRef: { value: "12" }, BillableStatus: "NotBillable" },
      },
    ]);
    expect(s.payload.Line.some((l) => l.DetailType === "AccountBasedExpenseLineDetail")).toBe(false);
  });

  it("completed after the vendor was linked: waits for CDS's approval, like any shop", () => {
    const s = billState(inHouse(), none);
    expect(s).toMatchObject({ kind: "pending_approval", beforeSince: false, beforeVendorLink: false });
  });

  it("completed before the vendor was linked: waits for approval too, and the panel says why to check", () => {
    const s = billState(inHouse({}, { completedAt: "2026-11-19T18:00:00Z" }), none);
    expect(s).toMatchObject({ kind: "pending_approval", beforeSince: true, beforeVendorLink: true });
  });

  it("a link with no known time is treated as made now: nothing already completed is billed automatically", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const s = billState(inHouse({ vendor: { qboVendorId: "777", qboVendorName: "GESi", linkedAt: null } }), none, now);
    expect(s).toMatchObject({ kind: "pending_approval", beforeSince: true, beforeVendorLink: true });
  });

  it("a regular shop's link time never matters (bills turned on decides, as before)", () => {
    const s = billState(inHouse({}, { shopInHouse: false, shopName: "Diesel Pros", completedAt: "2026-11-19T18:00:00Z" }), none);
    expect(s).toMatchObject({ kind: "pending_approval", beforeSince: false, beforeVendorLink: false });
  });

  it("a TBD CDS cost waits, as for any shop", () => {
    const i = inHouse();
    i.lines[1] = { ...i.lines[1], shopUnitRate: null };
    expect(billState(i, none)).toMatchObject({ kind: "blocked" });
  });

  it("the bill run refuses an order CDS has not approved without claiming it", async () => {
    const claim = vi.fn();
    const deps = {
      load: async () => ({ inputs: inHouse({}, { completedAt: "2026-11-19T18:00:00Z" }), record: null }),
      claim,
      finish: vi.fn(),
      qbo: vi.fn(),
      saveDivision: vi.fn(),
      log: vi.fn(),
    } as unknown as BillRunDeps;
    expect(await runShopBill(deps, "22222222-2222-4222-8222-222222222222")).toEqual({
      status: "failed",
      message: "Approve the shop bill first (AFF Bill Pnd Approval).",
    });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("Admin > Shop bills lists the in-house shop for vendor linking", () => {
  const shops = [
    { id: "s1", short_code: "DPH", display_name: "Diesel Pros Houston", city: "Houston", region: "TX", is_in_house: false },
    { id: "s2", short_code: "CDS-IN-HOUSE", display_name: "CDS Inc (in-house)", city: null, region: null, is_in_house: true },
  ];

  it("labels it as in-house, never suggests a vendor by its name, and does not count it as a shop still to link", () => {
    const r = vendorLinkShops(shops, new Map());
    expect(r.rows.map((s) => [s.id, s.inHouse])).toEqual([
      ["s2", true],
      ["s1", false],
    ]);
    expect(r.options.find((o) => o.value === "s2")).toEqual({ value: "s2", label: "CDS Inc (in-house)", hint: "In-house: bills at CDS cost. Not linked: no bills" });
    expect(r.options.find((o) => o.value === "s1")).toEqual({ value: "s1", label: "Diesel Pros Houston", hint: "Not linked" });
    expect(r.rows[0].suggest).toBe(false);
    expect(r.rows[1].suggest).toBe(true);
    expect(r.unlinked).toBe(1);
  });

  it("a linked in-house shop shows its vendor", () => {
    const r = vendorLinkShops(shops, new Map([["s2", { affiliate_id: "s2", qbo_vendor_id: "777", qbo_vendor_name: "GESi" }]]));
    expect(r.options.find((o) => o.value === "s2")?.hint).toBe("In-house: bills at CDS cost. QuickBooks: GESi");
  });

  it("the section reads the in-house shop too and uses the helper", () => {
    const src = readFileSync(new URL("../../src/app/cds/admin/ShopBillsSection.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.eq\("is_in_house", false\)/);
    expect(src).toMatch(/is_in_house/);
    expect(src).toMatch(/vendorLinkShops\(/);
  });

  it("the work order panel explains an in-house order completed before the link", () => {
    const src = readFileSync(new URL("../../src/components/cds-wo/ShopBillPanel.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/beforeVendorLink/);
  });

  it("the bill loader reads when the vendor was linked", () => {
    const src = readFileSync(new URL("../../src/lib/qbo/bill-input.ts", import.meta.url), "utf8");
    expect(src).toMatch(/qbo_affiliate_vendor"\)\.select\("qbo_vendor_id, qbo_vendor_name, linked_at"\)/);
    expect(src).toMatch(/linkedAt: vendor\.linked_at/);
  });
});
