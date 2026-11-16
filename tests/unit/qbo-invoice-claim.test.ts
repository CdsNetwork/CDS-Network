/**
 * Review 2026-11-16 H3 and H4: the customer invoice is claimed in the database before
 * QuickBooks is called (public.cds_claim_qbo_invoice, 20261118030000_qbo_invoice_claims.sql).
 *
 * H3: the QuickBooks request id came from the number of refused attempts in integration_sync,
 * so overlapping failures could give two ids and two invoices. The id now comes from the claim.
 * H4: the invoice inputs could change while QuickBooks created the invoice. The claim is taken
 * before QuickBooks is called (the database then refuses input changes), the invoice is built
 * from what was read after the claim, and the result is recorded on the claim.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice, getInvoice: vi.fn(), listClasses: vi.fn(), qboLookups: vi.fn(() => ({})) }));
type Resolved = { payload: unknown; notes: string[]; subCustomer: { id: string; name: string } | null };
const resolveInvoiceQbo = vi.fn(async (_l: unknown, p: unknown): Promise<Resolved> => ({ payload: p, notes: [], subCustomer: null }));
vi.mock("@/lib/qbo/invoice-qbo", () => ({ resolveInvoiceQbo, cachedSubCustomer: vi.fn(async () => null), saveSubCustomer: vi.fn() }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn(async () => ({ realmId: "1" })) }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

const { QboError } = await import("@/lib/qbo/client");

const WO = "11111111-1111-4111-8111-111111111111";
const inserts: Record<string, unknown>[] = [];
/** Every database call in order: "rpc:<name>" or "from:<table>". */
const calls: string[] = [];
let rejectedCount = 0;
type RpcAnswer = { data?: unknown; error?: { code?: string; message: string } | null };
let claimAnswer: (args: Record<string, unknown>) => RpcAnswer;
const rpcArgs: Record<string, Record<string, unknown>[]> = {};
const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  calls.push(`rpc:${name}`);
  (rpcArgs[name] ??= []).push(args);
  if (name === "cds_claim_qbo_invoice") return { data: null, error: null, ...claimAnswer(args) };
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
    then: (resolve: (v: unknown) => void) => resolve({ count: rejectedCount, error: null }),
  };
  return q;
}
const supabase = { rpc, from: vi.fn((table: string) => query(table)) };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { createQuickBooksInvoice } = await import("@/app/cds/work-orders/[id]/actions");
const { invoiceSnapshot } = await import("@/lib/qbo/invoice-claim");

const payload = (amount = 500) => ({ Line: [{ Amount: amount }], CustomerRef: { value: "58", name: "Ryder Fleet Services" } });
const invoiceState = (over: Record<string, unknown> = {}, amount = 500) => ({
  status: "ready_to_invoice",
  qbInvoiceId: null,
  qbInvoiceNumber: null,
  invoicedAt: null,
  affiliateId: null,
  pendingQb: null,
  target: { locationId: null, siteNumber: null, locationName: null, city: null, poNumber: null, unitNumber: null },
  result: { ok: true, payload: payload(amount), itemText: {}, warnings: [] },
  ...over,
});
const snap = (amount = 500) => invoiceSnapshot({ payload: payload(amount), itemText: {} });
const claimed = (over: Record<string, unknown> = {}) => (args: Record<string, unknown>): RpcAnswer => ({
  data: { state: "sending", claim_id: "c1", attempt: 0, request_id: WO, snapshot: args.p_snapshot, ...over },
});
const finishes = () => (rpcArgs.cds_finish_qbo_invoice ?? []).map((a) => a.p_outcome);

beforeEach(() => {
  inserts.length = 0;
  calls.length = 0;
  for (const k of Object.keys(rpcArgs)) delete rpcArgs[k];
  rejectedCount = 0;
  claimAnswer = claimed();
  createInvoice.mockReset();
  loadInvoice.mockReset();
  resolveInvoiceQbo.mockClear();
  rpc.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the QuickBooks request id (H3)", () => {
  it("comes from the claim, not from the number of refusal rows", async () => {
    // Two overlapping requests both logged a refusal of the same attempt: two rows, one refusal.
    rejectedCount = 2;
    claimAnswer = claimed({ attempt: 1, request_id: `${WO}-r1` });
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });

    await createQuickBooksInvoice(WO);

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0][2]).toBe(`${WO}-r1`);
  });

  it("is never sent while another request holds the claim", async () => {
    claimAnswer = () => ({ error: { code: "P0001", message: "This invoice is already being created. Refresh in a moment." } });
    loadInvoice.mockResolvedValue(invoiceState());

    const res = await createQuickBooksInvoice(WO);

    expect(res).toEqual({ error: "This invoice is already being created. Refresh in a moment." });
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("moves on only after QuickBooks clearly refused; an unclear answer keeps it", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockRejectedValueOnce(new QboError("Invalid Reference Id", 400, "ValidationFault"));
    await createQuickBooksInvoice(WO);
    createInvoice.mockRejectedValueOnce(new QboError("timeout", 0));
    const res = await createQuickBooksInvoice(WO);
    expect(finishes()).toEqual(["refused", "unconfirmed"]);
    expect((res as { error: string }).error).toMatch(/did not confirm/);
  });

  it("releases the claim without moving on when QuickBooks was never called", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    resolveInvoiceQbo.mockRejectedValueOnce(new Error("lookup failed"));
    await createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(finishes()).toEqual(["not_sent"]);
  });
});

describe("the invoice inputs while QuickBooks creates the invoice (H4)", () => {
  it("claims before QuickBooks is called, then records the created invoice on the claim before marking the order", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockImplementation(async () => {
      calls.push("qbo:createInvoice");
      return { Id: "145", DocNumber: "1043" };
    });

    const res = await createQuickBooksInvoice(WO);

    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 1043 created") });
    const order = calls.filter((c) => c.startsWith("rpc:") || c.startsWith("qbo:"));
    expect(order).toEqual(["rpc:cds_claim_qbo_invoice", "qbo:createInvoice", "rpc:cds_finish_qbo_invoice", "rpc:cds_mark_invoiced"]);
    expect(rpcArgs.cds_claim_qbo_invoice[0]).toEqual({ p_work_order: WO, p_snapshot: snap() });
    expect(rpcArgs.cds_finish_qbo_invoice[0]).toMatchObject({ p_claim: "c1", p_outcome: "created", p_qb_invoice_id: "145" });
  });

  it("sends nothing when the order changed between reading it and claiming it", async () => {
    loadInvoice.mockResolvedValueOnce(invoiceState({}, 500)).mockResolvedValueOnce(invoiceState({}, 700));

    const res = await createQuickBooksInvoice(WO);

    expect(createInvoice).not.toHaveBeenCalled();
    expect(finishes()).toEqual(["not_sent"]);
    expect((res as { error: string }).error).toBe("The work order changed while the invoice was being prepared. Click Create QuickBooks invoice again.");
  });

  it("warns when QuickBooks may have used the details of an earlier unconfirmed attempt", async () => {
    claimAnswer = claimed({ snapshot: snap(500) });
    loadInvoice.mockResolvedValue(invoiceState({}, 700));
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });

    const res = await createQuickBooksInvoice(WO);

    expect(createInvoice.mock.calls[0][2]).toBe(WO);
    expect((res as { ok: string }).ok).toMatch(/QuickBooks invoice 1043 created/);
    expect((res as { ok: string }).ok).toMatch(/The work order changed after QuickBooks was first asked for this invoice\. Check invoice 1043 in QuickBooks against the order\./);
  });
});

describe("recording an invoice QuickBooks created earlier", () => {
  it("compares the order with the details the invoice was created from", async () => {
    claimAnswer = () => ({ data: { state: "created", qb_invoice_id: "145", snapshot: snap(500) } });
    loadInvoice.mockResolvedValue(invoiceState({ pendingQb: { id: "145", number: "1043", at: "2026-11-16T10:00:00Z" } }, 500));
    const same = await createQuickBooksInvoice(WO);
    expect((same as { ok: string }).ok).not.toMatch(/changed/);

    loadInvoice.mockResolvedValue(invoiceState({ pendingQb: { id: "145", number: "1043", at: "2026-11-16T10:00:00Z" } }, 700));
    const changed = await createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect((changed as { ok: string }).ok).toMatch(/QuickBooks invoice 1043 \(created earlier\) is now recorded/);
    expect((changed as { ok: string }).ok).toMatch(/The work order changed after QuickBooks was first asked for this invoice\. Check invoice 1043 in QuickBooks against the order\./);
  });

  it("records the invoice the claim knows about when the created row is missing", async () => {
    claimAnswer = () => ({ data: { state: "created", qb_invoice_id: "145", snapshot: snap() } });
    loadInvoice.mockResolvedValue(invoiceState());
    await createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpcArgs.cds_mark_invoiced[0]).toMatchObject({ p_work_order: WO, p_qb_invoice_id: "145" });
  });
});

describe("invoiceSnapshot", () => {
  it("is the same for the same invoice whatever the key order, and differs when an amount changes", () => {
    const a = invoiceSnapshot({ payload: { b: 1, a: [1, { y: 2, x: 1 }] }, itemText: {} });
    const b = invoiceSnapshot({ payload: { a: [1, { x: 1, y: 2 }], b: 1 }, itemText: {} });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceSnapshot({ payload: payload(500), itemText: {} })).not.toBe(invoiceSnapshot({ payload: payload(501), itemText: {} }));
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });
});
