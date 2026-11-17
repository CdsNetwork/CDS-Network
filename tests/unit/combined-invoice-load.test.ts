/**
 * One order across 2 shops (CDS, 2026-11-17, milestone M4): loadInvoice on either of two
 * linked work orders reads both and builds the one invoice for both (@/lib/qbo/invoice-combined),
 * with the first work order's target and shop; a work order on its own is loaded as before.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { loadInvoice } = await import("@/lib/qbo/invoice-input");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER = "c1";
const DPF = "i1";
const REMAN = "i2";

/** Every query resolves to that table's rows filtered by its eq() calls (or() is not filtered). */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const eq: [string, unknown][] = [];
    const rows = () => (tables[table] ?? []).filter((r) => eq.every(([k, v]) => !(k in r) || r[k] === v));
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "or", "in", "limit", "is"]) chain[m] = () => chain;
    chain.eq = (k: string, v: unknown) => (eq.push([k, v]), chain);
    chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    chain.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, fail);
    return chain;
  };
  return { from } as unknown as Parameters<typeof loadInvoice>[0];
}

const location = { id: "l1", code: "RYD-1", location_number: null, name: "Dallas", address_line1: "1 Main St", city: "Dallas", region: "TX", postal_code: "75201", country: "US" };
const order = (id: string, wo_number: number, status: string, affiliate_id: string, unit_number: string | null) => ({
  id,
  wo_number,
  status,
  market: "US",
  customer_id: CUSTOMER,
  affiliate_id,
  location_label: "Dallas",
  po_number: "0899253330",
  unit_number,
  customers: { name: "Ryder" },
  customer_locations: location,
});
const line = (work_order_id: string, catalog_item_id: string, sku: string, price: number) => ({
  work_order_id,
  catalog_item_id,
  qty: 1,
  description: null,
  catalog_items: { sku, name: sku },
  work_order_line_pricing: { customer_unit_price: price, tax_class: "parts" },
});

const tables = (links: Record<string, unknown>[], claims: Record<string, unknown>[] = []) => ({
  work_orders: [order(A, 104101, "completed", "shop-a", null), order(B, 104102, "in_process", "shop-b", "T-77")],
  work_order_internal: [
    { work_order_id: A, tax_parts: true, tax_labor: false, tax_shipping: false, qb_invoice_id: null },
    { work_order_id: B, tax_parts: true, tax_labor: false, tax_shipping: false, qb_invoice_id: null },
  ],
  work_order_lines: [line(A, DPF, "SVC-DPF", 325), line(B, REMAN, "REMAN-DPF", 1450)],
  qbo_customer_map: [{ customer_id: CUSTOMER, qbo_customer_id: "58", qbo_display_name: "Ryder Fleet Services" }],
  qbo_item_map: [
    { customer_id: null, catalog_item_id: DPF, qbo_item_id: "1", qbo_item_name: "DPF" },
    { customer_id: null, catalog_item_id: REMAN, qbo_item_id: "2", qbo_item_name: "Reman" },
  ],
  qbo_affiliate_class: [
    { affiliate_id: "shop-a", qbo_class_id: "CLS-A" },
    { affiliate_id: "shop-b", qbo_class_id: "CLS-B" },
  ],
  work_order_links: links,
  qbo_invoice_claims: claims,
});

describe("loadInvoice of a linked work order", () => {
  it("builds one invoice with the lines of both, from the second work order's page", async () => {
    const inv = await loadInvoice(fakeDb(tables([{ work_order_id: B, linked_work_order_id: A }])), B);
    expect(inv?.status).toBe("in_process");
    expect(inv?.combined).toMatchObject({ ownerId: A, linkedId: A });
    expect(inv?.combined?.orders.map((o) => [o.woNumber, o.lines.map((l) => [l.sku, l.amount])])).toEqual([
      [104101, [["SVC-DPF", 325]]],
      [104102, [["REMAN-DPF", 1450]]],
    ]);
    if (!inv?.result.ok) throw new Error("expected an invoice");
    expect(inv.result.payload.Line.map((l) => l.Amount)).toEqual([325, 1450]);
    expect(inv.result.payload.PrivateNote).toBe("Portal WO-104101 + WO-104102 | PO 0899253330");
    expect(inv.result.payload.ClassRef).toEqual({ value: "CLS-A" });
    // The first work order's shop and site; its unit is empty, so the second one's.
    expect(inv.affiliateId).toBe("shop-a");
    expect(inv.target).toMatchObject({ locationId: "l1", poNumber: "0899253330", unitNumber: "T-77" });
  });

  it("finds an invoice QuickBooks created for both and not recorded yet on the first work order's claim", async () => {
    const claims = [{ work_order_id: A, state: "created", qb_invoice_id: "145", linked_work_order_id: B, updated_at: "2026-11-17T10:00:00Z" }];
    const inv = await loadInvoice(fakeDb(tables([{ work_order_id: A, linked_work_order_id: B }], claims)), B);
    expect(inv?.pendingQb).toEqual({ id: "145", number: null, at: "2026-11-17T10:00:00Z" });
  });

  it("refuses more than two linked work orders", async () => {
    const links = [
      { work_order_id: A, linked_work_order_id: B },
      { work_order_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", linked_work_order_id: A },
    ];
    const inv = await loadInvoice(fakeDb(tables(links)), A);
    expect(inv?.combined).toBeNull();
    expect(inv?.result).toEqual({
      ok: false,
      problems: ["WO-104101 is linked to more than one other work order. One QuickBooks invoice covers two linked work orders: remove the extra link first."],
      warnings: [],
    });
  });

  it("is unchanged for a work order on its own", async () => {
    const inv = await loadInvoice(fakeDb(tables([])), B);
    expect(inv?.combined).toBeNull();
    if (!inv?.result.ok) throw new Error("expected an invoice");
    expect(inv.result.payload.Line.map((l) => l.Amount)).toEqual([1450]);
    expect(inv.result.payload.PrivateNote).toBe("Portal WO-104102 | PO 0899253330");
    expect(inv.affiliateId).toBe("shop-b");
  });
});
