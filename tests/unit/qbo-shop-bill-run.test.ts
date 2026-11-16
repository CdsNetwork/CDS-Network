/**
 * M3: creating the shop's bill (src/lib/qbo/bill-run.ts) with QuickBooks and the database
 * stubbed. One bill per work order, also for two calls at the same moment; a refusal is
 * recorded with QuickBooks's reason and CDS can retry; a bill already in QuickBooks for this
 * order is recorded instead of a second one; nothing runs until CDS chose the account or item.
 */
import { describe, expect, it, vi } from "vitest";
import { QboError } from "@/lib/qbo/client";
import type { BillInputs, BillRecord, QboBillPayload } from "@/lib/qbo/bill";
import { runShopBill, type BillOutcome, type BillRunDeps, type FoundBill } from "@/lib/qbo/bill-run";

const WO = "11111111-1111-4111-8111-111111111111";

function inputs(over: Partial<BillInputs> = {}): BillInputs {
  return {
    workOrder: {
      id: WO,
      woNumber: 104321,
      status: "completed",
      completedAt: "2026-11-17T06:30:00Z",
      shopInvoiceRef: "INV-7781",
      customerName: "Ryder",
      poNumber: null,
      unitNumber: null,
      shopName: "Diesel Pros Houston",
      shopInHouse: false,
    },
    lines: [{ sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125 }],
    deductions: [],
    vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
    setting: { kind: "account", id: "88", name: "Subcontractors" },
    classId: null,
    ...over,
  };
}

/** The database side, in memory, with the same rules as public.qbo_claim_shop_bill / qbo_finish_shop_bill. */
function fakeDb(start: BillRecord | null = null, data: () => BillInputs = () => inputs()) {
  let record: (BillRecord & { claimId: string | null; rejections: number }) | null = start ? { ...start, claimId: null, rejections: 0 } : null;
  let n = 0;
  const finishes: BillOutcome[] = [];
  const logs: string[] = [];
  const deps = {
    load: vi.fn(async () => ({ inputs: data(), record: record && { ...record } })),
    claim: vi.fn(async () => {
      await Promise.resolve();
      if (record?.status === "created") throw new Error(`This work order already has QuickBooks bill ${record.qbBillNumber}.`);
      if (record?.status === "creating") throw new Error("A QuickBooks bill is already being created for this work order. Refresh in a moment.");
      const claimId = `c${++n}`;
      const rejections = record?.rejections ?? 0;
      record = { status: "creating", qbBillId: null, qbBillNumber: null, qbTotal: null, error: null, claimedAt: new Date().toISOString(), billCreatedAt: null, claimId, rejections };
      return { claimId, requestId: rejections ? `bill-${WO}-r${rejections}` : `bill-${WO}` };
    }),
    finish: vi.fn(async (_wo: string, claimId: string, o: BillOutcome) => {
      finishes.push(o);
      if (!record) return;
      if (o.outcome === "created") {
        record = { ...record, status: "created", qbBillId: o.billId, qbBillNumber: o.number, qbTotal: o.total, error: null, claimId: null };
      } else if (record.claimId === claimId) {
        record = { ...record, status: "failed", error: o.error, claimId: null, rejections: record.rejections + (o.outcome === "rejected" ? 1 : 0) };
      }
    }),
    log: vi.fn(async (status: string, _id: string | null, note: string | null) => {
      logs.push(`${status}: ${note ?? ""}`);
    }),
  };
  return { deps, finishes, logs, get record() { return record; } };
}

type Created = { Id: string; DocNumber?: string; TotalAmt?: number };
function fakeQbo(over: { find?: FoundBill[]; create?: () => Promise<Created> } = {}) {
  const create = over.create ?? (async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { Id: "900", DocNumber: "INV-7781", TotalAmt: 250 };
  });
  const createBill = vi.fn<(payload: QboBillPayload, requestId: string) => Promise<Created>>(() => create());
  const findBills = vi.fn(async () => over.find ?? []);
  return { createBill, findBills, api: vi.fn(async () => ({ createBill, findBills })) };
}

const deps = (db: ReturnType<typeof fakeDb>, qbo: ReturnType<typeof fakeQbo>): BillRunDeps => ({ ...db.deps, qbo: qbo.api });

describe("runShopBill", () => {
  it("creates the bill once and records its id, number and total", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    const r = await runShopBill(deps(db, qbo), WO, "auto");
    expect(r).toEqual({ status: "created", message: "QuickBooks bill INV-7781 created ($250.00)." });
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    expect(qbo.createBill.mock.calls[0][1]).toBe(`bill-${WO}`);
    expect(db.record).toMatchObject({ status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 250 });
  });

  it("two calls at the same moment (shop completes, CDS clicks) create one bill", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    const [a, b] = await Promise.all([runShopBill(deps(db, qbo), WO, "auto"), runShopBill(deps(db, qbo), WO, "manual")]);
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    expect(db.deps.claim).toHaveBeenCalledTimes(2);
    expect([a, b].filter((r) => r.status === "created")).toHaveLength(1);
    const other = [a, b].find((r) => r.status !== "created")!;
    expect(other.status === "skipped" || other.status === "failed").toBe(true);
  });

  it("never sends a second bill once one is recorded", async () => {
    const db = fakeDb({ status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 250, error: null, claimedAt: null, billCreatedAt: null });
    const qbo = fakeQbo();
    expect((await runShopBill(deps(db, qbo), WO, "auto")).status).toBe("skipped");
    expect(await runShopBill(deps(db, qbo), WO, "manual")).toEqual({ status: "failed", message: "This work order already has QuickBooks bill INV-7781." });
    expect(qbo.createBill).not.toHaveBeenCalled();
    expect(db.deps.claim).not.toHaveBeenCalled();
  });

  it("records QuickBooks's refusal with the reason; CDS's retry sends a new request id", async () => {
    const db = fakeDb();
    let refuse = true;
    const qbo = fakeQbo({
      create: async () => {
        if (refuse) throw new QboError("Invalid Reference Id: Account assigned to this line is inactive", 400, "ValidationFault", "2500", "tid-1");
        return { Id: "901", DocNumber: "INV-7781", TotalAmt: 250 };
      },
    });
    const r = await runShopBill(deps(db, qbo), WO, "auto");
    expect(r).toEqual({ status: "failed", message: "QuickBooks refused the bill: Invalid Reference Id: Account assigned to this line is inactive" });
    expect(db.record).toMatchObject({ status: "failed", error: "QuickBooks refused the bill: Invalid Reference Id: Account assigned to this line is inactive" });
    expect(db.logs[0]).toContain("tid-1");
    // No automatic retry after a refusal.
    expect((await runShopBill(deps(db, qbo), WO, "auto")).status).toBe("skipped");
    refuse = false;
    const retry = await runShopBill(deps(db, qbo), WO, "manual");
    expect(retry.status).toBe("created");
    expect(qbo.createBill.mock.calls[1][1]).toBe(`bill-${WO}-r1`);
  });

  it("keeps the same request id after an unclear failure, so QuickBooks answers a retry with the same bill", async () => {
    const db = fakeDb();
    let fail = true;
    const qbo = fakeQbo({
      create: async () => {
        if (fail) throw new QboError("QuickBooks could not be reached (timeout)", 0);
        return { Id: "900", DocNumber: "INV-7781", TotalAmt: 250 };
      },
    });
    const r = await runShopBill(deps(db, qbo), WO, "auto");
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.message).toContain("Try again: a retry never creates a second bill");
    fail = false;
    await runShopBill(deps(db, qbo), WO, "manual");
    expect(qbo.createBill.mock.calls.map((c) => c[1])).toEqual([`bill-${WO}`, `bill-${WO}`]);
  });

  it("records a bill the portal already made for this order (found by number and vendor) instead of sending another", async () => {
    const db = fakeDb();
    const qbo = fakeQbo({ find: [{ Id: "777", DocNumber: "INV-7781", VendorRef: { value: "301" }, TotalAmt: 250, PrivateNote: "Portal WO-104321 | Shop invoice INV-7781" }] });
    const r = await runShopBill(deps(db, qbo), WO, "manual");
    expect(r).toEqual({ status: "created", message: "QuickBooks bill INV-7781 was already in QuickBooks and is now recorded ($250.00)." });
    expect(qbo.createBill).not.toHaveBeenCalled();
    expect(db.record).toMatchObject({ status: "created", qbBillId: "777" });
  });

  it("does not send a bill when the shop's invoice number is already on another bill of that vendor", async () => {
    const db = fakeDb();
    const qbo = fakeQbo({ find: [{ Id: "555", DocNumber: "INV-7781", VendorRef: { value: "301" }, TotalAmt: 99, PrivateNote: "" }] });
    const r = await runShopBill(deps(db, qbo), WO, "auto");
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.message).toBe(
      "QuickBooks already has bill INV-7781 from Diesel Pros LLC ($99.00), not made for this order. Check it in QuickBooks; no bill was created.",
    );
    expect(qbo.createBill).not.toHaveBeenCalled();
    // A bill with the same number from another vendor is not in the way.
    const db2 = fakeDb();
    const qbo2 = fakeQbo({ find: [{ Id: "556", DocNumber: "INV-7781", VendorRef: { value: "999" }, TotalAmt: 250, PrivateNote: "" }] });
    expect((await runShopBill(deps(db2, qbo2), WO, "auto")).status).toBe("created");
  });

  it("does nothing until CDS chose the expense account or item", async () => {
    const db = fakeDb(null, () => inputs({ setting: null }));
    const qbo = fakeQbo();
    expect(await runShopBill(deps(db, qbo), WO, "auto")).toEqual({ status: "skipped", reason: "not_set_up" });
    expect(await runShopBill(deps(db, qbo), WO, "manual")).toEqual({ status: "failed", message: "QuickBooks bills are not set up yet." });
    expect(db.deps.claim).not.toHaveBeenCalled();
    expect(qbo.api).not.toHaveBeenCalled();
  });

  it("does nothing automatically while a shop rate is TBD; CDS sees what to fix", async () => {
    const db = fakeDb(null, () => inputs({ lines: [{ sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: null }] }));
    const qbo = fakeQbo();
    expect((await runShopBill(deps(db, qbo), WO, "auto")).status).toBe("skipped");
    const manual = await runShopBill(deps(db, qbo), WO, "manual");
    expect(manual).toEqual({ status: "failed", message: "Fix these first: The shop rate for REC-DPF Recon DPF is not set yet (TBD). Enter it on the line." });
    expect(db.deps.claim).not.toHaveBeenCalled();
  });

  it("refreshes the QuickBooks token once when it was refused as expired", async () => {
    const db = fakeDb();
    let calls = 0;
    const qbo = fakeQbo({
      create: async () => {
        if (calls++ === 0) throw new QboError("Unauthorized", 401);
        return { Id: "900", DocNumber: "INV-7781", TotalAmt: 250 };
      },
    });
    expect((await runShopBill(deps(db, qbo), WO, "auto")).status).toBe("created");
    expect(qbo.api).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it("records a missing QuickBooks connection on the order without throwing", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    qbo.api.mockRejectedValueOnce(new QboError("QuickBooks is not connected. Connect it in Admin > Settings.", 0, "Config"));
    const r = await runShopBill(deps(db, qbo), WO, "auto");
    expect(r).toEqual({ status: "failed", message: "QuickBooks is not connected. Connect it in Admin > Settings." });
    expect(db.record).toMatchObject({ status: "failed", error: "QuickBooks is not connected. Connect it in Admin > Settings." });
  });
});
