/**
 * M3: when the shop's bill is created. Every bill waits for CDS's approval (Sarah, CDS,
 * 2026-11-23): the shop completing the job and CDS entering a shop rate start nothing. CDS's
 * "Approve and send to QuickBooks" records the approval (for the bill CDS saw) and runs the
 * bill at once; Retry runs it again after a failure. The run itself (one bill only, ready or
 * not) is tested in qbo-shop-bill-run.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireShop: vi.fn(async () => ({ id: "s1", kind: "shop" })),
  requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })),
}));
vi.mock("@/lib/portal-email-send", () => ({ emailCdsAfter: vi.fn() }));
const createShopBillAfter = vi.fn();
const createShopBill = vi.fn();
vi.mock("@/lib/qbo/bill-server", () => ({ createShopBillAfter, createShopBill }));
const loadBillInputs = vi.fn();
vi.mock("@/lib/qbo/bill-input", () => ({ loadBillInputs }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

let rpcError: { message: string; code?: string } | null = null;
const rpc = vi.fn(async (name: string, args?: unknown) => ({ data: name && args ? "33333333-3333-4333-8333-333333333333" : null, error: rpcError }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));

const shop = await import("@/app/shop/actions");
const cds = await import("@/app/cds/work-orders/[id]/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  rpcError = null;
  createShopBillAfter.mockClear();
  createShopBill.mockReset();
  rpc.mockClear();
  loadBillInputs.mockReset();
});

describe("no automatic shop bill", () => {
  it("the shop completing the job starts nothing", async () => {
    const r = await shop.completeJob(WO, {}, form({ invoice_ref: "INV-7781" }));
    expect(r.error).toBeFalsy();
    expect(createShopBillAfter).not.toHaveBeenCalled();
    expect(createShopBill).not.toHaveBeenCalled();
  });

  it("CDS entering a shop rate or a priced line with its rate starts nothing", async () => {
    await cds.setLineShopRate(WO, LINE, {}, form({ amount: "300" }));
    await cds.addPricedLine(WO, {}, form({ catalog_item_id: LINE, amount: "500", shop_rate: "300" }));
    expect(createShopBillAfter).not.toHaveBeenCalled();
    expect(createShopBill).not.toHaveBeenCalled();
  });
});

describe("Approve and send to QuickBooks", () => {
  const bill = (approvedAt: string | null = null) => ({
    inputs: {
      workOrder: {
        id: WO,
        woNumber: 104321,
        status: "completed",
        completedAt: "2026-11-17T06:30:00Z",
        shopInvoiceRef: "INV-7781",
        customerId: "cccccccc-0000-4000-8000-000000000001",
        customerName: "Ryder",
        poNumber: null,
        unitNumber: null,
        shopName: "Diesel Pros Houston",
        shopInHouse: false,
      },
      lines: [{ catalogItemId: LINE, sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125 }],
      deductions: [],
      vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
      setting: { deduction: null, since: null },
      classId: null,
      division: null,
      incomeDivisionName: null,
      itemMap: { customer: {}, default: { [LINE]: { qboItemId: "500", qboItemName: "DPF Cleaning" } } },
      approvedAt,
    },
    record: null,
  });

  it("records the approval, then creates the bill and shows its number", async () => {
    loadBillInputs.mockResolvedValue(bill());
    createShopBill.mockResolvedValue({ status: "created", message: "QuickBooks bill INV-7781 created ($250.00)." });
    const r = await cds.approveShopBill(WO, 250);
    expect(rpc).toHaveBeenCalledWith("cds_approve_shop_bill", { p_work_order: WO });
    expect(createShopBill).toHaveBeenCalledWith(WO);
    expect(r).toMatchObject({ ok: "QuickBooks bill INV-7781 created ($250.00)." });
  });

  it("refuses when the bill changed since CDS looked at it, without approving or sending", async () => {
    loadBillInputs.mockResolvedValue(bill());
    const r = await cds.approveShopBill(WO, 240);
    expect(r.error).toMatch(/changed/);
    expect(rpc).not.toHaveBeenCalled();
    expect(createShopBill).not.toHaveBeenCalled();
  });

  it("shows the database's reason when the approval is refused, and sends nothing", async () => {
    loadBillInputs.mockResolvedValue(bill());
    rpcError = { message: "This work order already has QuickBooks bill INV-7781." };
    expect(await cds.approveShopBill(WO, 250)).toEqual({ error: "This work order already has QuickBooks bill INV-7781." });
    expect(createShopBill).not.toHaveBeenCalled();
  });

  it("the bill is approved, but QuickBooks fails: the reason is shown (Retry keeps the approval)", async () => {
    loadBillInputs.mockResolvedValue(bill());
    createShopBill.mockResolvedValue({ status: "failed", message: "QuickBooks refused the bill: Invalid account" });
    expect(await cds.approveShopBill(WO, 250)).toEqual({ error: "Approved. QuickBooks refused the bill: Invalid account" });
  });
});

describe("Create bill / Retry", () => {
  it("runs at once and shows the bill number", async () => {
    createShopBill.mockResolvedValue({ status: "created", message: "QuickBooks bill INV-7781 created ($250.00)." });
    const r = await cds.createQuickBooksBill(WO);
    expect(createShopBill).toHaveBeenCalledWith(WO);
    expect(r).toMatchObject({ ok: "QuickBooks bill INV-7781 created ($250.00)." });
  });

  it("shows QuickBooks's reason when it fails", async () => {
    createShopBill.mockResolvedValue({ status: "failed", message: "QuickBooks refused the bill: Invalid account" });
    expect(await cds.createQuickBooksBill(WO)).toEqual({ error: "QuickBooks refused the bill: Invalid account" });
  });

  it("refuses a bad work order id without calling anything", async () => {
    expect(await cds.createQuickBooksBill("x")).toEqual({ error: "Work order not found." });
    expect(createShopBill).not.toHaveBeenCalled();
  });
});

describe("shops add parts and Misc. hardware without an authorization request", () => {
  it("a catalog part goes through shop_add_part", async () => {
    expect((await shop.addPart(WO, {}, form({ catalog_item: LINE, qty: "2" }))).error).toBeFalsy();
    expect(rpc).toHaveBeenCalledWith("shop_add_part", { p_work_order: WO, p_catalog_item: LINE, p_qty: 2 });
  });

  it("Misc. hardware goes in with the description and the amount on the shop's invoice", async () => {
    const r = await shop.addPart(WO, {}, form({ catalog_item: LINE, per_line: "1", description: " Kit bolts ", amount: "12.40" }));
    expect(r.error).toBeFalsy();
    expect(rpc).toHaveBeenCalledWith("shop_add_pass_through_line", { p_work_order: WO, p_catalog_item: LINE, p_description: "Kit bolts", p_amount: 12.4 });
  });

  it("Misc. hardware without a description or a valid amount is refused before the database", async () => {
    expect((await shop.addPart(WO, {}, form({ catalog_item: LINE, per_line: "1", description: "", amount: "5" }))).error).toMatch(/description/i);
    for (const amount of ["", "0", "-2", "1.234", "abc"]) {
      expect((await shop.addPart(WO, {}, form({ catalog_item: LINE, per_line: "1", description: "Bolts", amount }))).error, amount).toMatch(/amount/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
