/**
 * The $15 per filter shared shipping deduction on the shop's bill
 * (20261111030000_shop_filter_shipping_deduction.sql). The database computes the deduction
 * (view work_order_shop_deductions); the pages show it like any other line and take it off
 * the shop total. The customer invoice never sees it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEADER, toRow, type BackupOrder } from "@/lib/sheets/columns";
import { deductionLabel, shopPayable, toShopDeductions } from "@/lib/shop-deductions";

const deduction = { kind: "filter_shipping" as const, filters: 3, unit_amount: -15, amount: -45 };

describe("toShopDeductions", () => {
  it("turns view rows (numeric as strings) into numbers", () => {
    expect(
      toShopDeductions([{ work_order_id: "w", kind: "filter_shipping", filters: 2, unit_amount: "-15.00", amount: "-30.00" }]),
    ).toEqual([{ kind: "filter_shipping", filters: 2, unit_amount: -15, amount: -30 }]);
    expect(toShopDeductions(null)).toEqual([]);
  });
});

describe("shopPayable", () => {
  const lines = [
    { qty: 2, shop_unit_rate: 230 },
    { qty: 1, shop_unit_rate: null },
    { qty: 1, shop_unit_rate: 80 },
  ];

  it("is the lines at the shop rate plus the deductions", () => {
    expect(shopPayable(lines, [deduction])).toBe(495);
  });

  it("is the lines alone when there is no deduction", () => {
    expect(shopPayable(lines, [])).toBe(540);
  });

  it("rounds to cents", () => {
    expect(shopPayable([{ qty: 3, shop_unit_rate: 0.1 }], [])).toBe(0.3);
  });
});

describe("deductionLabel", () => {
  it("names the filters and the amount per filter", () => {
    expect(deductionLabel(deduction)).toBe("Shared shipping deduction: 3 filters x $15.00 round trip");
    expect(deductionLabel({ ...deduction, filters: 1, amount: -15 })).toBe(
      "Shared shipping deduction: 1 filter x $15.00 round trip",
    );
  });

  it("has no em or en dash", () => {
    expect(deductionLabel(deduction)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("Sheets backup", () => {
  const order: BackupOrder = {
    woNumber: 1,
    createdAt: "2026-11-11T17:00:00Z",
    status: "completed",
    customer: "Ryder",
    locationCode: null,
    location: "FREMONT",
    shop: "Shop",
    unitNumber: null,
    poNumber: null,
    vin: null,
    mileage: null,
    requestedWork: "Clean DPF",
    dispatchedAt: null,
    pickedUpAt: null,
    completedAt: null,
    deliveredAt: null,
    shopInvoiceRef: "R-1",
    supplierCostTbd: false,
    invoiceNumber: null,
    invoicedAt: null,
    updatedAt: "2026-11-11T18:00:00Z",
    lines: [{ sku: "SVC-DPF", name: "DPF Cleaning", qty: 2, shopUnitRate: 230, customerUnitPrice: 335 }],
    components: [],
    shipments: [],
    shopDeductions: -30,
  };
  const cell = (o: BackupOrder, h: string) => toRow(o)[HEADER.indexOf(h as (typeof HEADER)[number])];

  it("takes the deduction off the vendor bill and adds it to the profit", () => {
    expect(cell(order, "VENDOR BILL $ AMT")).toBe(430);
    expect(cell(order, "PROFIT")).toBe(240);
    expect(cell(order, "CUSTOMER BILL $ AMT")).toBe(670);
  });
});

describe("pages show the deduction and use it in the shop total", () => {
  const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

  it("the shop job page", () => {
    const page = read("components/shop/JobDetail.tsx");
    expect(page).toContain("shopPayable(lines, deductions)");
    expect(page).toContain("deductionLabel(");
    const data = read("app/shop/data.ts");
    expect(data).toContain("work_order_shop_deductions");
  });

  it("the CDS preview of the shop page", () => {
    const page = read("app/cds/affiliate-view/ShopPreview.tsx");
    expect(page).toContain("work_order_shop_deductions");
    expect(page).toContain("shopPayable(lines, deductions)");
    expect(page).toContain("deductionLabel(");
  });

  it("the CDS work order page, with the customer invoice from the lines only", () => {
    const page = read("app/cds/work-orders/[id]/page.tsx");
    expect(page).toContain("work_order_shop_deductions");
    expect(page).toContain("shopPayable(lines, deductions)");
    expect(page).toContain("deductionLabel(");
    // The customer side (subtotal, tax, invoice total) is computed from the lines alone.
    expect(page).toMatch(/taxSummary\(\s*lines\.map/);
  });

  it("the Sheets backup loads the deductions", () => {
    expect(read("lib/sheets/source.ts")).toContain("work_order_shop_deductions");
  });

  it("the customer invoice code never reads the deductions", () => {
    for (const f of ["lib/qbo/invoice.ts", "lib/qbo/invoice-input.ts"]) {
      expect(read(f)).not.toContain("shop_deductions");
    }
  });
});
