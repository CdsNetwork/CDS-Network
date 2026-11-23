/**
 * Shop bill approval (Sarah, CDS, 2026-11-23: "every order please"). A completed order's shop
 * bill waits for CDS: "AFF Bill Pnd Approval" with the bill preview, then "Approve and send to
 * QuickBooks" records the approval and runs the bill as before. Nothing is sent on its own.
 * CDS can still change the lines of a completed order until the bill exists.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { billState, type BillInputs, type BillRecord } from "@/lib/qbo/bill";
import { runShopBill, type BillRunDeps } from "@/lib/qbo/bill-run";
import { linesLocked, SHOP_BILL_PENDING_LABEL } from "@/components/cds-wo/util";

const WO = "11111111-1111-4111-8111-111111111111";
const CLEAN = "aaaaaaaa-0000-4000-8000-000000000001";

function inputs(over: Partial<BillInputs> = {}, wo: Partial<BillInputs["workOrder"]> = {}): BillInputs {
  return {
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
      ...wo,
    },
    lines: [{ catalogItemId: CLEAN, sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125 }],
    deductions: [],
    vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
    setting: { deduction: null, since: null },
    classId: null,
    division: null,
    incomeDivisionName: null,
    itemMap: { customer: {}, default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" } } },
    approvedAt: null,
    ...over,
  };
}

describe("billState with approval", () => {
  it("completed and complete, not approved: pending approval with the bill preview (lines, amounts, bill number)", () => {
    const s = billState(inputs(), null);
    expect(s.kind).toBe("pending_approval");
    if (s.kind !== "pending_approval") throw new Error(s.kind);
    expect(s.total).toBe(250);
    expect(s.payload.DocNumber).toBe("INV-7781");
    expect(s.payload.Line).toHaveLength(1);
    expect(s.payload.Line[0]).toMatchObject({ Amount: 250 });
  });

  it("approved: ready to send; a failed send after approval keeps the approval for the Retry", () => {
    expect(billState(inputs({ approvedAt: "2026-11-23T18:00:00Z" }), null)).toMatchObject({ kind: "ready", approvedAt: "2026-11-23T18:00:00Z" });
    const failed: BillRecord = { status: "failed", qbBillId: null, qbBillNumber: null, qbTotal: null, error: "Invalid account", claimedAt: null, billCreatedAt: null };
    expect(billState(inputs({ approvedAt: "2026-11-23T18:00:00Z" }), failed)).toMatchObject({ kind: "ready", lastError: "Invalid account" });
    // A failed attempt from before approvals existed waits for approval, its reason shown.
    expect(billState(inputs(), failed)).toMatchObject({ kind: "pending_approval", lastError: "Invalid account" });
  });

  it("the bill exists: created, approved or not (orders billed before this change are unchanged)", () => {
    const rec: BillRecord = { status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 250, error: null, claimedAt: null, billCreatedAt: "2026-11-17T07:00:00Z" };
    expect(billState(inputs(), rec).kind).toBe("created");
    expect(billState(inputs({ approvedAt: "2026-11-23T18:00:00Z" }), rec).kind).toBe("created");
  });

  it("something to fix first (a TBD rate): blocked, approved or not", () => {
    const tbd = { lines: [{ catalogItemId: CLEAN, sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: null }] };
    expect(billState(inputs(tbd), null).kind).toBe("blocked");
    expect(billState(inputs({ ...tbd, approvedAt: "2026-11-23T18:00:00Z" }), null).kind).toBe("blocked");
  });

  it("old orders: completed before bills were turned on also wait for approval, with the warning flag", () => {
    const s = billState(inputs({ setting: { deduction: null, since: "2026-11-20T00:00:00Z" } }), null);
    expect(s).toMatchObject({ kind: "pending_approval", beforeSince: true });
  });

  it("in-house orders wait for approval once the in-house shop is linked to a vendor; without a link, no bill", () => {
    const inHouse = { shopInHouse: true, completedAt: "2026-11-23T06:30:00Z" };
    const linked = { vendor: { qboVendorId: "777", qboVendorName: "GESi", linkedAt: "2026-11-20T00:00:00Z" } };
    expect(billState(inputs(linked, inHouse), null).kind).toBe("pending_approval");
    expect(billState(inputs({ vendor: null }, inHouse), null).kind).toBe("none");
  });
});

describe("runShopBill needs the approval", () => {
  function deps(data: BillInputs): BillRunDeps & { claim: ReturnType<typeof vi.fn> } {
    return {
      load: vi.fn(async () => ({ inputs: data, record: null })),
      claim: vi.fn(async () => ({ claimId: "c1", requestId: `bill-${WO}` })),
      finish: vi.fn(async () => {}),
      qbo: vi.fn(async () => {
        throw new Error("QuickBooks must not be called");
      }),
      saveDivision: vi.fn(async () => {}),
      log: vi.fn(async () => {}),
    };
  }

  it("refuses an order CDS has not approved, before claiming or calling QuickBooks", async () => {
    const d = deps(inputs());
    expect(await runShopBill(d, WO)).toEqual({ status: "failed", message: "Approve the shop bill first (AFF Bill Pnd Approval)." });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.qbo).not.toHaveBeenCalled();
  });

  it("has no automatic mode anymore: the only caller is CDS's button", () => {
    const server = readFileSync(new URL("../../src/lib/qbo/bill-server.ts", import.meta.url), "utf8");
    expect(server).not.toMatch(/createShopBillAfter|after\(/);
    for (const file of ["../../src/app/shop/actions.ts", "../../src/app/cds/work-orders/[id]/actions.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/createShopBillAfter/);
    }
  });
});

describe("lines of a completed order stay editable for CDS until the shop bill exists", () => {
  it("open while the shop works, and after completion until the bill exists; locked once invoiced, invoice-locked or cancelled", () => {
    expect(linesLocked("in_process", false, false)).toBe(false);
    for (const status of ["completed", "delivered", "ready_to_invoice"]) {
      expect(linesLocked(status, false, false), status).toBe(false);
      expect(linesLocked(status, false, true), status).toBe(true);
      expect(linesLocked(status, true, false), status).toBe(true);
    }
    expect(linesLocked("invoiced", true, false)).toBe(true);
    expect(linesLocked("cancelled", false, false)).toBe(true);
  });

  it("the dashboard, the CSV export and the work order page use the same words", () => {
    expect(SHOP_BILL_PENDING_LABEL).toBe("AFF Bill Pnd Approval");
    const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
    expect(src("app/cds/page.tsx")).toMatch(/SHOP_BILL_PENDING_LABEL/);
    expect(src("app/cds/export/route.ts")).toMatch(/SHOP_BILL_PENDING_LABEL/);
    expect(src("components/cds-wo/ShopBillPanel.tsx")).toMatch(/SHOP_BILL_PENDING_LABEL/);
    expect(src("components/cds-wo/ShopBillPanel.tsx")).toMatch(/Approve and send to QuickBooks/);
  });
});
