/**
 * A work order can be created, and an item added, while the item has no customer price yet
 * (Sarah, CDS office, 2026-11-16: "CDS-NEW FILTER" on a Ryder order). The line shows
 * "No price", the order's customer totals say TBD instead of counting it as $0, and the
 * QuickBooks invoice is refused until the price is set
 * (20261117010000_work_order_without_price.sql).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInvoicePayload, type InvoiceLine, type InvoiceWorkOrder } from "@/lib/qbo/invoice";
import { customerSubtotal, missingPriceSkus, setPriceMessage } from "@/lib/line-price";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const FILTER = "22222222-2222-4222-8222-222222222222";

const wo: InvoiceWorkOrder = {
  id: "99999999-9999-4999-8999-999999999999",
  woNumber: 100200,
  market: "US",
  customerName: "Ryder",
  poNumber: "PO-1",
  unitNumber: "U-1",
  taxParts: true,
  taxLabor: false,
  taxShipping: false,
  customerTaxExempt: false,
};

const location = {
  label: "RY-1 Yard",
  addressLine1: "1 Example Rd",
  city: "Dallas",
  region: "TX",
  postalCode: "75201",
  country: "US",
};

function invoice(lines: InvoiceLine[], mapped: string[] = [SERVICE, FILTER]) {
  const items = Object.fromEntries(mapped.map((id, i) => [id, { qboItemId: String(i + 1), qboItemName: `Item ${i + 1}` }]));
  return buildInvoicePayload(
    wo,
    lines,
    { qboCustomerId: "58", qboDisplayName: "Ryder" },
    { customer: {}, default: items },
    {},
    location,
    [],
    { customer: {}, default: {} },
  );
}

describe("creating a work order with an item that has no price", () => {
  const form = readFileSync("src/components/cds-wo/NewWorkOrderForm.tsx", "utf8");

  it("does not block Create Work Order", () => {
    expect(form).not.toMatch(/Set a fleet price before creating the order/);
    expect(form).not.toMatch(/disabled=\{pending \|\| missingPrice\}/);
  });

  it("still shows the line as No price", () => {
    expect(form).toMatch(/"No price"/);
  });
});

describe("adding an item with no price to an existing order", () => {
  it("is not refused by the action", () => {
    const actions = readFileSync("src/app/cds/work-orders/[id]/actions.ts", "utf8");
    expect(actions).not.toMatch(/Set a fleet price first/);
  });

  it("shows No price on the order page instead of $0.00", () => {
    const page = readFileSync("src/app/cds/work-orders/[id]/page.tsx", "utf8");
    expect(page).toMatch(/"No price"/);
  });
});

describe("customer totals with a line that has no price", () => {
  const lines = [
    { sku: "CDS-DPF", qty: 1, price: 325 },
    { sku: "CDS-NEW FILTER", qty: 1, price: null },
    { sku: "CDS-NEW FILTER", qty: 2, price: null },
  ];

  it("are not a number (TBD), never the other lines' sum", () => {
    expect(customerSubtotal(lines)).toBeNull();
    expect(customerSubtotal([lines[0]])).toBe(325);
    expect(customerSubtotal([])).toBe(0);
  });

  it("name each item without a price once", () => {
    expect(missingPriceSkus(lines)).toEqual(["CDS-NEW FILTER"]);
    expect(setPriceMessage(["CDS-NEW FILTER"])).toBe("Set a price for CDS-NEW FILTER before creating the invoice.");
    expect(setPriceMessage(["A", "B"])).toBe("Set a price for A and B before creating the invoice.");
    expect(setPriceMessage(["A", "B", "C"])).toBe("Set a price for A, B and C before creating the invoice.");
  });
});

describe("the QuickBooks invoice while a line has no price", () => {
  const priced: InvoiceLine = { catalogItemId: SERVICE, sku: "CDS-DPF", name: "DPF cleaning", qty: 1, customerUnitPrice: 325, taxClass: "labor" };
  const unpriced: InvoiceLine = { catalogItemId: FILTER, sku: "CDS-NEW FILTER", name: "New Filter", qty: 1, customerUnitPrice: null, taxClass: "parts" };

  it("is refused, naming the item", () => {
    const r = invoice([priced, unpriced]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toContain("Set a price for CDS-NEW FILTER before creating the invoice.");
  });

  it("is refused for the price even when the item is not linked to QuickBooks yet", () => {
    const r = invoice([priced, unpriced], [SERVICE]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toContain("Set a price for CDS-NEW FILTER before creating the invoice.");
    expect(r.problems.some((p) => p.includes("not linked to a QuickBooks item"))).toBe(true);
  });

  it("goes through once the price is set", () => {
    expect(invoice([priced, { ...unpriced, customerUnitPrice: 410 }]).ok).toBe(true);
  });
});
