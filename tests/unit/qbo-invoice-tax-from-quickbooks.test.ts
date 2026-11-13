/**
 * CDS (Sarah, 2026-11-13): WO-102096 (ship-to Harmony, PA) showed "Sales tax (0%) $0.00" and
 * "No jurisdiction recorded" although QuickBooks invoice 40126 was created for it with PA
 * sales tax. QuickBooks Automated Sales Tax is the source of truth: once the invoice exists,
 * the work order page shows the tax and total QuickBooks calculated (Invoice.TxnTaxDetail
 * .TotalTax and Invoice.TotalAmt, stored on work_order_internal by cds_mark_invoiced). Before
 * that, the portal's own figure is labelled as an estimate, and an order with no rate and no
 * jurisdiction does not claim $0 tax.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
const getInvoice = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice, getInvoice, qboLookups: vi.fn(() => ({})) }));
vi.mock("@/lib/qbo/invoice-qbo", () => ({
  resolveInvoiceQbo: vi.fn(async (_l: unknown, p: unknown) => ({ payload: p, notes: [], subCustomer: null })),
  cachedSubCustomer: vi.fn(async () => null),
  saveSubCustomer: vi.fn(async () => {}),
}));
const qboApi = vi.fn(async () => ({ realmId: "1" }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

const rpc = vi.fn();
const supabase = {
  rpc,
  from: vi.fn(() => {
    const q = {
      insert: vi.fn(async () => ({ error: null })),
      select: () => q,
      eq: () => q,
      then: (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }),
    };
    return q;
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { createQuickBooksInvoice } = await import("@/app/cds/work-orders/[id]/actions");
const { invoiceTaxView, qbInvoiceAmounts } = await import("@/lib/tax");

const WO = "11111111-1111-4111-8111-111111111111";
const payload = { Line: [], CustomerRef: { value: "58", name: "Customer" } };
const invoiceState = (over: Record<string, unknown> = {}) => ({
  status: "ready_to_invoice",
  qbInvoiceId: null,
  qbInvoiceNumber: null,
  invoicedAt: null,
  pendingQb: null,
  target: { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: null, unitNumber: null },
  result: { ok: true, payload, warnings: [] },
  ...over,
});

beforeEach(() => {
  createInvoice.mockReset();
  getInvoice.mockReset();
  rpc.mockReset();
  loadInvoice.mockReset();
  qboApi.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("qbInvoiceAmounts", () => {
  it("reads the tax and total QuickBooks calculated", () => {
    expect(qbInvoiceAmounts({ TotalAmt: 1060, TxnTaxDetail: { TotalTax: 60 } })).toEqual({ taxTotal: 60, total: 1060 });
    expect(qbInvoiceAmounts({ TotalAmt: 500, TxnTaxDetail: { TotalTax: 0 } })).toEqual({ taxTotal: 0, total: 500 });
  });

  it("is null for what QuickBooks did not return", () => {
    expect(qbInvoiceAmounts({ TotalAmt: 500 })).toEqual({ taxTotal: null, total: 500 });
    expect(qbInvoiceAmounts({})).toEqual({ taxTotal: null, total: null });
    expect(qbInvoiceAmounts(null)).toEqual({ taxTotal: null, total: null });
  });
});

describe("createQuickBooksInvoice stores the QuickBooks tax and total", () => {
  it("passes Invoice.TxnTaxDetail.TotalTax and Invoice.TotalAmt to cds_mark_invoiced", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "40126", TotalAmt: 1060, TxnTaxDetail: { TotalTax: 60 } });
    rpc.mockResolvedValue({ error: null });

    const res = await createQuickBooksInvoice(WO);

    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 40126 created") });
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", {
      p_work_order: WO,
      p_qb_invoice_id: "145",
      p_qb_invoice_number: "40126",
      p_qb_tax_total: 60,
      p_qb_total: 1060,
    });
  });

  it("records the invoice with no amounts when QuickBooks returned none", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "40126" });
    rpc.mockResolvedValue({ error: null });
    await createQuickBooksInvoice(WO);
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", expect.objectContaining({ p_qb_tax_total: null, p_qb_total: null }));
  });

  it("reads the amounts of an invoice created earlier (recovered) from QuickBooks before recording it", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ pendingQb: { id: "145", number: "40126", at: "2026-11-13T10:00:00Z" } }));
    getInvoice.mockResolvedValue({ Id: "145", DocNumber: "40126", TotalAmt: 1060, TxnTaxDetail: { TotalTax: 60 } });
    rpc.mockResolvedValue({ error: null });

    const res = await createQuickBooksInvoice(WO);

    expect(createInvoice).not.toHaveBeenCalled();
    expect(getInvoice).toHaveBeenCalledWith(expect.anything(), "145");
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", {
      p_work_order: WO,
      p_qb_invoice_id: "145",
      p_qb_invoice_number: "40126",
      p_qb_tax_total: 60,
      p_qb_total: 1060,
    });
    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 40126") });
  });

  it("still records a recovered invoice when QuickBooks cannot be read", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ pendingQb: { id: "145", number: "40126", at: "2026-11-13T10:00:00Z" } }));
    getInvoice.mockRejectedValue(new Error("timeout"));
    rpc.mockResolvedValue({ error: null });
    const res = await createQuickBooksInvoice(WO);
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", expect.objectContaining({ p_qb_invoice_id: "145", p_qb_tax_total: null, p_qb_total: null }));
    expect(res).toMatchObject({ ok: expect.any(String) });
  });
});

describe("invoiceTaxView (the Customer invoice & tax box)", () => {
  const estimate = { subtotal: 1000, taxable: 1000, salesTax: 0, total: 1000 };
  const base = {
    qbInvoiceId: null,
    qbInvoiceNumber: null,
    qbTaxTotal: null,
    qbTotal: null,
    customerTaxExempt: false,
    rate: 0,
    jurisdiction: null,
    estimate,
  };

  it("shows the tax and total QuickBooks calculated once the invoice exists (WO-102096)", () => {
    const v = invoiceTaxView({ ...base, qbInvoiceId: "145", qbInvoiceNumber: "40126", qbTaxTotal: 60, qbTotal: 1060 });
    expect(v.taxLabel).toBe("Sales tax (QuickBooks)");
    expect(v.tax).toBe(60);
    expect(v.totalLabel).toBe("Customer invoice total");
    expect(v.total).toBe(1060);
    expect(v.note).toMatch(/QuickBooks calculates (the )?(sales )?tax from the ship-to address/);
    expect(v.note).toMatch(/40126/);
  });

  it("does not claim $0 for an invoice whose amounts were not recorded", () => {
    const v = invoiceTaxView({ ...base, qbInvoiceId: "145", qbInvoiceNumber: "40126" });
    expect(v.taxLabel).toBe("Sales tax (QuickBooks)");
    expect(v.tax).toBeNull();
    expect(v.total).toBeNull();
    expect(v.note).toMatch(/invoice 40126 in QuickBooks/);
  });

  it("labels the portal's figure as an estimate before the invoice exists", () => {
    const v = invoiceTaxView({ ...base, rate: 6, jurisdiction: "PA", estimate: { subtotal: 1000, taxable: 1000, salesTax: 60, total: 1060 } });
    expect(v.taxLabel).toBe("Estimated sales tax (6%)");
    expect(v.tax).toBe(60);
    expect(v.totalLabel).toBe("Estimated customer invoice total");
    expect(v.total).toBe(1060);
  });

  it("says QuickBooks calculates the tax when there is no rate and no jurisdiction", () => {
    const v = invoiceTaxView(base);
    expect(v.taxLabel).toBe("Estimated sales tax");
    expect(v.tax).toBeNull();
    expect(v.taxText).toBe("Calculated by QuickBooks");
    expect(v.note).toMatch(/QuickBooks calculates the tax when the invoice is created/);
    expect(v.totalLabel).toBe("Customer invoice total before tax");
    expect(v.total).toBe(1000);
  });

  it("keeps $0 for a tax exempt customer and for an order with nothing taxable", () => {
    const exempt = invoiceTaxView({ ...base, customerTaxExempt: true });
    expect(exempt.taxLabel).toBe("Sales tax (customer exempt)");
    expect(exempt.tax).toBe(0);
    expect(exempt.total).toBe(1000);
    const nothingTaxable = invoiceTaxView({ ...base, estimate: { subtotal: 1000, taxable: 0, salesTax: 0, total: 1000 } });
    expect(nothingTaxable.tax).toBe(0);
    expect(nothingTaxable.taxLabel).toBe("Estimated sales tax (0%)");
  });
});

describe("work order page", () => {
  const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
  it("loads the QuickBooks amounts and shows the box through invoiceTaxView", () => {
    expect(page).toMatch(/qb_tax_total, qb_total/);
    expect(page).toMatch(/invoiceTaxView\(/);
    expect(page).not.toMatch(/`Sales tax \(\$\{rate\}%\)`/);
  });
});
