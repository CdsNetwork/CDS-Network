/**
 * CDS billing (2026-11-12): every invoice carries the QuickBooks Division (Department) of its
 * customer, for example RYDER INCOME for every Ryder invoice, and the Class of the CDS
 * location (the shop) that handled the order, for example CDS Houston. CDS's company tracks
 * classes per transaction (not per line), so both refs go on the invoice header. The mapping
 * is data CDS maintains (qbo_customer_division, qbo_affiliate_class); without a row the
 * invoice is exactly as before, never blocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildInvoicePayload, type InvoiceLine, type InvoiceWorkOrder } from "@/lib/qbo/invoice";
import { loadInvoice } from "@/lib/qbo/invoice-input";
import { resolveInvoiceQbo, type InvoiceTarget, type QboLookups } from "@/lib/qbo/invoice-qbo";

const ITEM = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const SHOP = "a0000000-0000-4000-8000-000000000001";
const WO = "99999999-9999-4999-8999-999999999999";

const wo: InvoiceWorkOrder = {
  id: WO,
  woNumber: 100200,
  market: "US",
  customerName: "Ryder",
  poNumber: null,
  unitNumber: null,
  taxParts: false,
  taxLabor: false,
  taxShipping: false,
  customerTaxExempt: false,
};
const lines: InvoiceLine[] = [{ catalogItemId: ITEM, sku: "SVC", name: "DPF cleaning", qty: 1, customerUnitPrice: 300, taxClass: "labor" }];
const location = { label: "R-1 Houston", addressLine1: "1 Main St", city: "Houston", region: "TX", postalCode: "77001", country: "US" };

function build(refs?: Parameters<typeof buildInvoicePayload>[8]) {
  const args: Required<Parameters<typeof buildInvoicePayload>> extends [...infer Head, unknown] ? Head : never = [
    wo,
    lines,
    { qboCustomerId: "58", qboDisplayName: "Ryder Fleet Services" },
    { customer: {}, default: { [ITEM]: { qboItemId: "7", qboItemName: "DPF" } } },
    {},
    location,
    [],
    { customer: {}, default: {} },
  ];
  const r = refs === undefined ? buildInvoicePayload(...args) : buildInvoicePayload(...args, refs);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.payload;
}

describe("Class and Division on the invoice", () => {
  it("puts DepartmentRef (Division) and ClassRef on the invoice header", () => {
    const p = build({ departmentId: "3", classId: "5000000000000012345" });
    expect(p.DepartmentRef).toEqual({ value: "3" });
    expect(p.ClassRef).toEqual({ value: "5000000000000012345" });
    // Not on the lines: CDS's company has ClassTrackingPerTxnLine off.
    for (const l of p.Line) expect(l.SalesItemLineDetail).not.toHaveProperty("ClassRef");
  });

  it("leaves the payload exactly as before without a mapping", () => {
    const before = build();
    expect(before).not.toHaveProperty("DepartmentRef");
    expect(before).not.toHaveProperty("ClassRef");
    expect(build({})).toEqual(before);
    expect(build({ departmentId: null, classId: "  " })).toEqual(before);
  });

  it("sets only the ref that is mapped", () => {
    const division = build({ departmentId: "3" });
    expect(division.DepartmentRef).toEqual({ value: "3" });
    expect(division).not.toHaveProperty("ClassRef");
    const cls = build({ classId: " 12 " });
    expect(cls.ClassRef).toEqual({ value: "12" });
    expect(cls).not.toHaveProperty("DepartmentRef");
  });

  it("keeps both refs through the QuickBooks lookups (sub-customer, custom fields)", async () => {
    const lookups: QboLookups = {
      getCustomer: async () => null,
      listSubCustomers: async () => [],
      salesFormsPrefs: async () => null,
      recentInvoiceCustomFields: async () => [],
      getItems: async () => [],
    };
    const target: InvoiceTarget = { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: null, unitNumber: null };
    const r = await resolveInvoiceQbo(lookups, build({ departmentId: "3", classId: "12" }), target, null);
    expect(r.payload.DepartmentRef).toEqual({ value: "3" });
    expect(r.payload.ClassRef).toEqual({ value: "12" });
  });
});

/**
 * A stand-in for the Supabase client: every query on a table resolves to that table's rows,
 * filtered by the eq() calls; maybeSingle() gives the first row or null. The filters each
 * query used are recorded so the test can check what was looked up.
 */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const queries: { table: string; eq: [string, unknown][] }[] = [];
  const from = (table: string) => {
    const q = { table, eq: [] as [string, unknown][] };
    queries.push(q);
    const rows = () => (tables[table] ?? []).filter((r) => q.eq.every(([k, v]) => !(k in r) || r[k] === v));
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "or", "in", "limit", "is"]) chain[m] = () => chain;
    chain.eq = (k: string, v: unknown) => {
      q.eq.push([k, v]);
      return chain;
    };
    chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    chain.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(ok, fail);
    return chain;
  };
  return { db: { from } as unknown as Parameters<typeof loadInvoice>[0], queries };
}

function workOrderTables(extra: Record<string, Record<string, unknown>[]> = {}) {
  return {
    work_orders: [
      {
        id: WO,
        wo_number: 100200,
        status: "ready_to_invoice",
        market: "US",
        customer_id: CUSTOMER,
        affiliate_id: SHOP,
        location_label: "Houston",
        po_number: null,
        unit_number: null,
        customers: { name: "Ryder" },
        customer_locations: {
          id: "l1",
          code: "R-1",
          location_number: null,
          name: "Houston",
          address_line1: "1 Main St",
          city: "Houston",
          region: "TX",
          postal_code: "77001",
          country: "US",
        },
      },
    ],
    work_order_internal: [{ work_order_id: WO, tax_parts: false, tax_labor: false, tax_shipping: false, qb_invoice_id: null }],
    work_order_lines: [
      {
        catalog_item_id: ITEM,
        qty: 1,
        description: null,
        catalog_items: { sku: "SVC", name: "DPF cleaning" },
        work_order_line_pricing: { customer_unit_price: 300, tax_class: "labor" },
      },
    ],
    qbo_customer_map: [{ customer_id: CUSTOMER, qbo_customer_id: "58", qbo_display_name: "Ryder Fleet Services" }],
    qbo_item_map: [{ customer_id: null, catalog_item_id: ITEM, qbo_item_id: "7", qbo_item_name: "DPF" }],
    ...extra,
  };
}

describe("loadInvoice: Class and Division", () => {
  it("looks up the Division by the work order's customer and the Class by its shop", async () => {
    const { db, queries } = fakeDb(
      workOrderTables({
        qbo_customer_division: [
          { customer_id: "someone-else", qbo_department_id: "9", qbo_department_name: "OTHER" },
          { customer_id: CUSTOMER, qbo_department_id: "3", qbo_department_name: "RYDER INCOME" },
        ],
        qbo_affiliate_class: [
          { affiliate_id: "other-shop", qbo_class_id: "99", qbo_class_name: "CDS Sacramento" },
          { affiliate_id: SHOP, qbo_class_id: "12", qbo_class_name: "CDS Houston" },
        ],
      }),
    );
    const invoice = await loadInvoice(db, WO);
    if (!invoice?.result.ok) throw new Error("expected an invoice");
    expect(invoice.result.payload.DepartmentRef).toEqual({ value: "3" });
    expect(invoice.result.payload.ClassRef).toEqual({ value: "12" });
    expect(queries.find((q) => q.table === "qbo_customer_division")?.eq).toEqual([["customer_id", CUSTOMER]]);
    expect(queries.find((q) => q.table === "qbo_affiliate_class")?.eq).toEqual([["affiliate_id", SHOP]]);
  });

  it("builds today's invoice when neither is mapped", async () => {
    const { db } = fakeDb(workOrderTables());
    const invoice = await loadInvoice(db, WO);
    if (!invoice?.result.ok) throw new Error("expected an invoice");
    expect(invoice.result.payload).not.toHaveProperty("DepartmentRef");
    expect(invoice.result.payload).not.toHaveProperty("ClassRef");
  });

  it("does not look up a Class for a work order without a shop", async () => {
    const tables = workOrderTables({
      qbo_affiliate_class: [{ affiliate_id: SHOP, qbo_class_id: "12", qbo_class_name: "CDS Houston" }],
    });
    (tables.work_orders[0] as Record<string, unknown>).affiliate_id = null;
    const { db, queries } = fakeDb(tables);
    const invoice = await loadInvoice(db, WO);
    if (!invoice?.result.ok) throw new Error("expected an invoice");
    expect(invoice.result.payload).not.toHaveProperty("ClassRef");
    expect(queries.some((q) => q.table === "qbo_affiliate_class")).toBe(false);
  });
});
