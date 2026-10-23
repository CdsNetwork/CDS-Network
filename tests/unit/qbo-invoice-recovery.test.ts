/**
 * QA observation (m2-r1/billing): QuickBooks created the invoice but marking the work order
 * Invoiced failed. The QuickBooks invoice must stay recorded so that the next click records it
 * instead of sending a new invoice, and staff see on the page what happened.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const createInvoice = vi.fn();
vi.mock("@/lib/qbo/api", () => ({ createInvoice }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn(async () => ({ realmId: "1" })) }));
const loadInvoice = vi.fn();
vi.mock("@/lib/qbo/invoice-input", () => ({ loadInvoice }));

const inserts: Record<string, unknown>[] = [];
const rpc = vi.fn();
let rejectedCount = 0;
function countQuery() {
  const q = {
    select: () => q,
    eq: () => q,
    then: (resolve: (v: unknown) => void) => resolve({ count: rejectedCount, error: null }),
  };
  return q;
}
const supabase = {
  rpc,
  from: vi.fn(() => ({
    insert: vi.fn(async (row: Record<string, unknown>) => {
      inserts.push(row);
      return { error: null };
    }),
    ...countQuery(),
  })),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { createQuickBooksInvoice } = await import("@/app/cds/work-orders/[id]/actions");
const { pendingQbInvoice, createdNote } = await import("@/lib/qbo/pending");

const WO = "11111111-1111-4111-8111-111111111111";
const payload = { Line: [] };
const invoiceState = (over: Record<string, unknown> = {}) => ({
  status: "ready_to_invoice",
  qbInvoiceId: null,
  qbInvoiceNumber: null,
  invoicedAt: null,
  pendingQb: null,
  result: { ok: true, payload, warnings: [] },
  ...over,
});

beforeEach(() => {
  inserts.length = 0;
  rejectedCount = 0;
  createInvoice.mockReset();
  rpc.mockReset();
  loadInvoice.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pendingQbInvoice", () => {
  it("finds the newest invoice QuickBooks created, with its number", () => {
    expect(
      pendingQbInvoice([
        { status: "error", external_id: "145", error: "Invoice created in QuickBooks, portal not updated: boom", at: "2026-10-23T10:00:01Z" },
        { status: "ok", external_id: "145", error: createdNote("1043"), at: "2026-10-23T10:00:00Z" },
        { status: "rejected", external_id: null, error: "bad item", at: "2026-10-23T09:00:00Z" },
      ]),
    ).toEqual({ id: "145", number: "1043", at: "2026-10-23T10:00:00Z" });
  });

  it("keeps the id when no number was stored, and is null without a created invoice", () => {
    expect(pendingQbInvoice([{ status: "ok", external_id: "145", error: null, at: "2026-10-23T10:00:00Z" }])).toEqual({
      id: "145",
      number: null,
      at: "2026-10-23T10:00:00Z",
    });
    expect(pendingQbInvoice([{ status: "error", external_id: null, error: "timeout", at: "2026-10-23T10:00:00Z" }])).toBeNull();
    expect(pendingQbInvoice([])).toBeNull();
  });
});

describe("createQuickBooksInvoice when the portal update fails", () => {
  it("records the created invoice id and number before marking, and names it in the message", async () => {
    loadInvoice.mockResolvedValue(invoiceState());
    createInvoice.mockResolvedValue({ Id: "145", DocNumber: "1043" });
    rpc.mockResolvedValue({ error: { message: "connection reset" } });

    const res = await createQuickBooksInvoice(WO);

    expect(inserts[0]).toMatchObject({ system: "quickbooks", entity: "invoice", entity_id: WO, status: "ok", external_id: "145", error: createdNote("1043") });
    expect(res).toMatchObject({ error: expect.stringContaining("QuickBooks invoice 1043 was created") });
    expect((res as { error: string }).error).toMatch(/no second invoice/);
  });

  it("records the invoice QuickBooks already created on the next click instead of sending a new one", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ pendingQb: { id: "145", number: "1043", at: "2026-10-23T10:00:00Z" } }));
    rpc.mockResolvedValue({ error: null });

    const res = await createQuickBooksInvoice(WO);

    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", { p_work_order: WO, p_qb_invoice_id: "145", p_qb_invoice_number: "1043" });
    expect(res).toMatchObject({ ok: expect.stringContaining("QuickBooks invoice 1043") });
  });

  it("records it even when the invoice details changed since and would no longer build", async () => {
    loadInvoice.mockResolvedValue(
      invoiceState({ pendingQb: { id: "145", number: null, at: "2026-10-23T10:00:00Z" }, result: { ok: false, problems: ["No price"], warnings: [] } }),
    );
    rpc.mockResolvedValue({ error: null });
    await createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("cds_mark_invoiced", { p_work_order: WO, p_qb_invoice_id: "145", p_qb_invoice_number: null });
  });

  it("tells staff about the invoice when the order moved on and never sends a new one", async () => {
    loadInvoice.mockResolvedValue(invoiceState({ status: "cancelled", pendingQb: { id: "145", number: "1043", at: "2026-10-23T10:00:00Z" } }));
    const res = await createQuickBooksInvoice(WO);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect((res as { error: string }).error).toMatch(/QuickBooks invoice 1043 was created.*not recorded/);
  });
});

describe("work order page", () => {
  it("shows the created but unrecorded invoice on the Ready to Invoice panel", () => {
    const page = readFileSync(new URL("../../src/app/cds/work-orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/invoice\?\.pendingQb/);
    expect(page).toMatch(/was created in QuickBooks/);
  });
});
