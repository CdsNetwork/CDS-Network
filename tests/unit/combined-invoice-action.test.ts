/**
 * One order across 2 shops (CDS, 2026-11-17, milestone M4): "Create QuickBooks invoice" on
 * either of two linked work orders creates ONE QuickBooks invoice for both and records it on
 * both. The claim is on the first work order (lowest WO number) and names the other one, so
 * the two pages can never send two invoices; the database side is in
 * tests/rls/combined-invoice.test.ts. Work orders that are not linked are unchanged (the
 * existing tests in qbo-invoice-claim, invoice-any-time and qbo-invoice-recovery).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
const getInvoice = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice, getInvoice, listClasses: vi.fn(), qboLookups: vi.fn(() => ({})) }));
type Resolved = { payload: unknown; notes: string[]; subCustomer: { id: string; name: string } | null };
const resolveInvoiceQbo = vi.fn(async (_l: unknown, p: unknown): Promise<Resolved> => ({ payload: p, notes: [], subCustomer: null }));
vi.mock("@/lib/qbo/invoice-qbo", () => ({ resolveInvoiceQbo, cachedSubCustomer: vi.fn(async () => null), saveSubCustomer: vi.fn() }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn(async () => ({ realmId: "1" })) }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

const { QboError } = await import("@/lib/qbo/client");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inserts: Record<string, unknown>[] = [];
const calls: string[] = [];
type RpcAnswer = { data?: unknown; error?: { code?: string; message: string } | null };
let claimAnswer: (args: Record<string, unknown>) => RpcAnswer;
let markAnswer: RpcAnswer;
const rpcArgs: Record<string, Record<string, unknown>[]> = {};
const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  calls.push(`rpc:${name}`);
  (rpcArgs[name] ??= []).push(args);
  if (name === "cds_claim_qbo_invoice") return { data: null, error: null, ...claimAnswer(args) };
  if (name === "cds_mark_invoiced_linked") return { data: null, error: null, ...markAnswer };
  return { data: null, error: null };
});
function query(table: string) {
  calls.push(`from:${table}`);
  const q = {
    select: () => q,
    eq: () => q,
    insert: vi.fn(async (row: Record<string, unknown>) => {
      inserts.push(row);
      return { error: null };
    }),
    then: (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }),
  };
  return q;
}
const supabase = { rpc, from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { createQuickBooksInvoice } = await import("@/app/cds/work-orders/[id]/actions");
const { invoiceSnapshot } = await import("@/lib/qbo/invoice-claim");

const payload = { Line: [{ Amount: 325 }, { Amount: 1450 }], CustomerRef: { value: "58", name: "Ryder" }, PrivateNote: "Portal WO-104101 + WO-104102" };
const orders = [
  { id: A, woNumber: 104101, status: "completed", qbInvoiceId: null, qbInvoiceNumber: null, lines: [] },
  { id: B, woNumber: 104102, status: "in_process", qbInvoiceId: null, qbInvoiceNumber: null, lines: [] },
];
/** The invoice as loaded on the page of `page` (A or B): the other one is the linked one. */
const combinedState = (page: string, over: Record<string, unknown> = {}) => ({
  status: page === A ? "completed" : "in_process",
  qbInvoiceId: null,
  qbInvoiceNumber: null,
  invoicedAt: null,
  affiliateId: "shop-a",
  pendingQb: null,
  target: { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: "0899253330", unitNumber: "T-77" },
  result: { ok: true, payload, itemText: [], warnings: [] },
  combined: { ownerId: A, linkedId: page === A ? B : A, orders },
  ...over,
});
const snap = invoiceSnapshot({ payload, itemText: [] });
const claimed = (over: Record<string, unknown> = {}) => (args: Record<string, unknown>): RpcAnswer => ({
  data: { state: "sending", claim_id: "c1", attempt: 0, request_id: A, snapshot: args.p_snapshot, work_order_id: A, linked_work_order_id: B, ...over },
});
const finishes = () => (rpcArgs.cds_finish_qbo_invoice ?? []).map((a) => [a.p_work_order, a.p_outcome]);

beforeEach(() => {
  inserts.length = 0;
  calls.length = 0;
  for (const k of Object.keys(rpcArgs)) delete rpcArgs[k];
  claimAnswer = claimed();
  markAnswer = {};
  createInvoice.mockReset();
  getInvoice.mockReset();
  loadInvoice.mockReset();
  resolveInvoiceQbo.mockClear();
  revalidatePath.mockClear();
  rpc.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("creating the invoice of two linked work orders", () => {
  it("from the second work order: claims for both, sends one invoice and records it on both", async () => {
    loadInvoice.mockResolvedValue(combinedState(B));
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043", TotalAmt: 1900, TxnTaxDetail: { TotalTax: 125 } });

    const res = await createQuickBooksInvoice(B);

    expect(rpcArgs.cds_claim_qbo_invoice).toEqual([{ p_work_order: B, p_snapshot: snap, p_linked: A }]);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0][1]).toEqual(payload);
    expect(createInvoice.mock.calls[0][2]).toBe(A);
    expect(finishes()).toEqual([[A, "created"]]);
    expect(rpcArgs.cds_mark_invoiced_linked).toEqual([
      { p_work_order: A, p_linked: B, p_qb_invoice_id: "145", p_qb_invoice_number: "1043", p_qb_tax_total: 125, p_qb_total: 1900 },
    ]);
    expect(rpcArgs.cds_mark_invoiced).toBeUndefined();
    // The created invoice is findable from either work order.
    const ok = inserts.filter((r) => r.entity === "invoice" && r.status === "ok");
    expect(ok.map((r) => r.entity_id).sort()).toEqual([A, B]);
    expect(ok.every((r) => r.external_id === "145")).toBe(true);
    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 1043 created for WO-104101 and WO-104102.") });
    expect((res as { ok: string }).ok).toContain("WO-104101 is now Invoiced.");
    expect((res as { ok: string }).ok).toContain("WO-104102 moves to Invoiced when the shop completes the job.");
    expect(revalidatePath).toHaveBeenCalledWith(`/cds/work-orders/${A}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/cds/work-orders/${B}`);
  });

  it("records an invoice QuickBooks already created for both, without sending another", async () => {
    loadInvoice.mockResolvedValue(combinedState(A));
    claimAnswer = () => ({ data: { state: "created", qb_invoice_id: "145", snapshot: snap, work_order_id: A, linked_work_order_id: B } });
    getInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043", TotalAmt: 1900, TxnTaxDetail: { TotalTax: 125 } });

    const res = await createQuickBooksInvoice(A);

    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpcArgs.cds_mark_invoiced_linked).toEqual([
      { p_work_order: A, p_linked: B, p_qb_invoice_id: "145", p_qb_invoice_number: "1043", p_qb_tax_total: 125, p_qb_total: 1900 },
    ]);
    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 1043 (created earlier) is now recorded on WO-104101 and WO-104102.") });
  });

  it("keeps the request id after an unclear answer and logs the failure on both work orders", async () => {
    loadInvoice.mockResolvedValue(combinedState(B));
    createInvoice.mockRejectedValue(new QboError("timeout", 0));

    const res = await createQuickBooksInvoice(B);

    expect(finishes()).toEqual([[A, "unconfirmed"]]);
    expect(inserts.filter((r) => r.status === "error").map((r) => r.entity_id).sort()).toEqual([A, B]);
    expect((res as { error: string }).error).toMatch(/did not confirm/);
    expect(rpcArgs.cds_mark_invoiced_linked).toBeUndefined();
  });

  it("moves to the next request id after a refusal", async () => {
    loadInvoice.mockResolvedValue(combinedState(A));
    createInvoice.mockRejectedValue(new QboError("Invalid Reference Id", 400, "ValidationFault"));
    await createQuickBooksInvoice(A);
    expect(finishes()).toEqual([[A, "refused"]]);
  });

  it("sends nothing when the work orders changed while the claim was taken", async () => {
    loadInvoice.mockResolvedValueOnce(combinedState(B)).mockResolvedValueOnce(combinedState(B, { combined: null }));
    const res = await createQuickBooksInvoice(B);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(finishes()).toEqual([[A, "not_sent"]]);
    expect((res as { error: string }).error).toMatch(/changed/);
  });

  it("sends nothing and claims nothing when one of them is not ready, and says which", async () => {
    loadInvoice.mockResolvedValue(
      combinedState(A, { result: { ok: false, problems: ["WO-104102 is cancelled. Remove the link to invoice WO-104101 on its own."], warnings: [] } }),
    );
    const res = await createQuickBooksInvoice(A);
    expect(res).toEqual({ error: "Fix these first: WO-104102 is cancelled. Remove the link to invoice WO-104101 on its own." });
    expect(rpcArgs.cds_claim_qbo_invoice).toBeUndefined();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("passes on the database refusal, for example the other order invoiced on its own meanwhile", async () => {
    loadInvoice.mockResolvedValue(combinedState(A));
    claimAnswer = () => ({ error: { code: "P0001", message: "Linked work order WO-104102 already has QuickBooks invoice 99. Remove the link to invoice this work order on its own." } });
    const res = await createQuickBooksInvoice(A);
    expect((res as { error: string }).error).toMatch(/WO-104102 already has QuickBooks invoice 99/);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("says when the invoice was created but recording it on the work orders failed", async () => {
    loadInvoice.mockResolvedValue(combinedState(A));
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });
    markAnswer = { error: { message: "connection reset" } };
    const res = await createQuickBooksInvoice(A);
    expect((res as { error: string }).error).toMatch(/QuickBooks invoice 1043 was created, but WO-104101 and WO-104102 could not be updated/);
    expect((res as { error: string }).error).toMatch(/no second invoice/);
  });
});
