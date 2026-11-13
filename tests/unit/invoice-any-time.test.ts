/**
 * Invoice any time (CDS, 2026-11-12): CDS may create the customer invoice in QuickBooks at any
 * status except cancelled and already invoiced, not only at Ready to Invoice. An order whose
 * work is done (completed, delivered, ready to invoice) moves to Invoiced as before; an order
 * the shop is still working on keeps its status and moves to Invoiced when the shop completes
 * it. Once an order has a QuickBooks invoice, its customer lines, tax and customer/location are
 * locked like an invoiced order, so they stay in step with QuickBooks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice, qboLookups: vi.fn(() => ({})) }));
vi.mock("@/lib/qbo/invoice-qbo", () => ({
  resolveInvoiceQbo: vi.fn(async (_l: unknown, p: unknown) => ({ payload: p, notes: [], subCustomer: null })),
  cachedSubCustomer: vi.fn(async () => null),
  saveSubCustomer: vi.fn(async () => {}),
}));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn(async () => ({ realmId: "1" })) }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

type Call = { table: string; op: string; row?: unknown };
const calls: Call[] = [];
const rpc = vi.fn();
/** What the work order read returns: its status and its QuickBooks invoice, if any. */
let wo: { status: string; work_order_internal: { qb_invoice_id: string | null } | null };

function query(table: string) {
  const call: Call = { table, op: "select" };
  calls.push(call);
  const result = () => {
    if (table === "work_orders") return { data: wo, error: null };
    if (table === "integration_sync") return { count: 0, data: null, error: null };
    if (table === "shipments") return { data: { carrier: "UPS", tracking_number: null, label_status: "needed" }, error: null };
    if (table === "shipment_labels") return { count: 0, data: null, error: null };
    return { data: [{ id: "x" }], error: null };
  };
  const q = {
    select: () => q,
    eq: () => q,
    is: () => q,
    in: () => q,
    update: (row: unknown) => ((call.op = "update"), (call.row = row), q),
    delete: () => ((call.op = "delete"), q),
    insert: async (row: unknown) => ((call.op = "insert"), (call.row = row), { error: null }),
    maybeSingle: async () => result(),
    single: async () => result(),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return q;
}
const supabase = { rpc, from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const actions = await import("@/app/cds/work-orders/[id]/actions");
const lock = await import("@/lib/invoice-lock");

const WO = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const payload = { Line: [], CustomerRef: { value: "58", name: "Ryder Fleet Services" } };
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
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const writes = (table: string) => calls.filter((c) => c.table === table && c.op !== "select");

beforeEach(() => {
  calls.length = 0;
  createInvoice.mockReset();
  rpc.mockReset();
  loadInvoice.mockReset();
  wo = { status: "in_process", work_order_internal: { qb_invoice_id: null } };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the invoice lock helper", () => {
  it("is locked when the order is invoiced or has a QuickBooks invoice, whatever its status", () => {
    expect(lock.invoiceLocked("invoiced", null)).toBe(true);
    expect(lock.invoiceLocked("in_process", "145")).toBe(true);
    expect(lock.invoiceLocked("awaiting_acceptance", "145")).toBe(true);
    expect(lock.invoiceLocked("in_process", null)).toBe(false);
    expect(lock.invoiceLocked("ready_to_invoice", null)).toBe(false);
    expect(lock.invoiceLocked("completed", undefined)).toBe(false);
  });

  it("lets CDS invoice at any status except cancelled and invoiced, and not twice", () => {
    for (const s of ["pending_review", "awaiting_acceptance", "accepted", "picked_up", "in_process", "rejected_by_affiliate", "completed", "delivered", "ready_to_invoice"]) {
      expect(lock.invoiceBlockReason(s, null), s).toBeNull();
    }
    expect(lock.invoiceBlockReason("cancelled", null)).toMatch(/cancelled/i);
    expect(lock.invoiceBlockReason("invoiced", null)).toMatch(/already invoiced/i);
    expect(lock.invoiceBlockReason("in_process", "145")).toMatch(/already/i);
  });

  it("moves to Invoiced right away only when the work is done", () => {
    for (const s of ["completed", "delivered", "ready_to_invoice"]) expect(lock.movesToInvoiced(s), s).toBe(true);
    for (const s of ["pending_review", "awaiting_acceptance", "accepted", "picked_up", "in_process", "rejected_by_affiliate"]) {
      expect(lock.movesToInvoiced(s), s).toBe(false);
    }
  });
});

describe("createQuickBooksInvoice at any status", () => {
  it("creates the invoice for an order the shop is still working on, records it, and says the status stays", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ status: "in_process" }));
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });
    rpc.mockResolvedValue({ error: null });

    const res = await actions.createQuickBooksInvoice(WO);

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", { p_work_order: WO, p_qb_invoice_id: "145", p_qb_invoice_number: "1043", p_qb_tax_total: null, p_qb_total: null });
    const ok = (res as { ok: string }).ok;
    expect(ok).toMatch(/QuickBooks invoice 1043 created/);
    expect(ok).toMatch(/moves to Invoiced when the shop completes/);
  });

  it("still moves a Ready to Invoice order to Invoiced, as before", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ status: "ready_to_invoice" }));
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });
    rpc.mockResolvedValue({ error: null });
    const res = await actions.createQuickBooksInvoice(WO);
    expect((res as { ok: string }).ok).toMatch(/The work order is now Invoiced/);
  });

  it("invoices a completed or delivered order without the Ready to Invoice step", async () => {
    for (const status of ["completed", "delivered"]) {
      createInvoice.mockReset();
      loadInvoice.mockResolvedValue(invoiceState({ status }));
      createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });
      rpc.mockResolvedValue({ error: null });
      const res = await actions.createQuickBooksInvoice(WO);
      expect(createInvoice, status).toHaveBeenCalledTimes(1);
      expect((res as { ok: string }).ok, status).toMatch(/now Invoiced/);
    }
  });

  it("never sends a cancelled or an invoiced order to QuickBooks", async () => {
    for (const status of ["cancelled", "invoiced"]) {
      loadInvoice.mockResolvedValue(invoiceState({ status }));
      const res = await actions.createQuickBooksInvoice(WO);
      expect((res as { error: string }).error, status).toBeTruthy();
    }
    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never sends a second invoice for an in-progress order that already has one", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ status: "in_process", qbInvoiceId: "145", qbInvoiceNumber: "1043" }));
    const res = await actions.createQuickBooksInvoice(WO);
    expect((res as { error: string }).error).toMatch(/already has QuickBooks invoice 1043/);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("keeps the build checks: a draft with no customer or lines is not sent", async () => {
    loadInvoice.mockResolvedValue(
      invoiceState({ status: "pending_review", result: { ok: false, problems: ["The work order has no lines to invoice."], warnings: [] } }),
    );
    const res = await actions.createQuickBooksInvoice(WO);
    expect((res as { error: string }).error).toMatch(/no lines to invoice/);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("records an invoice QuickBooks already created for an in-progress order instead of refusing it", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ status: "in_process", pendingQb: { id: "145", number: "1043", at: "2026-11-12T10:00:00Z" } }));
    rpc.mockResolvedValue({ error: null });
    const res = await actions.createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", { p_work_order: WO, p_qb_invoice_id: "145", p_qb_invoice_number: "1043", p_qb_tax_total: null, p_qb_total: null });
    expect((res as { ok: string }).ok).toMatch(/moves to Invoiced when the shop completes/);
  });
});

describe("the lock on an in-progress order that has a QuickBooks invoice", () => {
  beforeEach(() => {
    wo = { status: "in_process", work_order_internal: { qb_invoice_id: "145" } };
  });

  it("refuses CDS adding or removing a line", async () => {
    const added = await actions.addLine(WO, {}, form({ catalog_item_id: ITEM, qty: "1" }));
    expect((added as { error: string }).error).toMatch(/invoiced/i);
    const removed = await actions.removeLine(WO, LINE);
    expect((removed as { error: string }).error).toMatch(/invoiced/i);
    expect(writes("work_order_lines")).toEqual([]);
  });

  it("refuses a tax change", async () => {
    const res = await actions.updateTax(WO, {}, form({ tax_rate: "8" }));
    expect((res as { error: string }).error).toMatch(/invoiced/i);
    expect(writes("work_order_internal")).toEqual([]);
  });

  it("refuses removing a shipment", async () => {
    const res = await actions.removeShipment(WO, LINE);
    expect((res as { error: string }).error).toMatch(/invoiced/i);
    expect(writes("shipments")).toEqual([]);
  });

  it("refuses a customer or location change", async () => {
    wo = { status: "rejected_by_affiliate", work_order_internal: { qb_invoice_id: "145" } };
    const res = await actions.updateWorkOrderFields(
      WO,
      {},
      form({
        unit_number: "U1",
        requested_work: "Clean",
        location_label: "Yard",
        request_type: "service",
        fulfillment: "shipping",
        customer_id: ITEM,
        location_id: "",
      }),
    );
    expect((res as { error: string }).error).toMatch(/invoiced/i);
    expect(writes("work_orders")).toEqual([]);
  });

  it("still lets CDS add a line to an in-progress order without a QuickBooks invoice", async () => {
    wo = { status: "in_process", work_order_internal: { qb_invoice_id: null } };
    const res = await actions.addLine(WO, {}, form({ catalog_item_id: ITEM, qty: "1" }));
    expect(res).toMatchObject({ ok: "Line added." });
  });
});
