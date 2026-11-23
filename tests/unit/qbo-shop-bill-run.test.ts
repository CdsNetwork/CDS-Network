/**
 * M3: creating the shop's bill (src/lib/qbo/bill-run.ts) with QuickBooks and the database
 * stubbed. One bill per work order, also for two calls at the same moment; a refusal is
 * recorded with QuickBooks's reason and CDS can retry; a bill already in QuickBooks for this
 * order is recorded instead of a second one; nothing runs until CDS turned bills on; an item
 * without an expense account in QuickBooks stops the bill before it is sent.
 */
import { describe, expect, it, vi } from "vitest";
import { QboError } from "@/lib/qbo/client";
import type { QboTerm } from "@/lib/qbo/api";
import type { BillInputs, BillRecord, QboBillItem, QboBillPayload } from "@/lib/qbo/bill";
import type { QboDepartment } from "@/lib/qbo/cogs-division";
import { runShopBill, type BillOutcome, type BillRunDeps, type FoundBill } from "@/lib/qbo/bill-run";

const WO = "11111111-1111-4111-8111-111111111111";
const CLEAN = "aaaaaaaa-0000-4000-8000-000000000001";

function inputs(over: Partial<BillInputs> = {}): BillInputs {
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
    },
    lines: [{ catalogItemId: CLEAN, sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125 }],
    deductions: [],
    vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
    setting: { deduction: null, since: null },
    classId: null,
    division: null,
    incomeDivisionName: "RYDER INCOME",
    itemMap: { customer: {}, default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" } } },
    // Approved by CDS (Approve and send to QuickBooks); without it nothing runs (shop-bill-approval.test.ts).
    approvedAt: "2026-11-17T07:00:00Z",
    ...over,
  };
}

/** The database side, in memory, with the same rules as public.qbo_claim_shop_bill / qbo_finish_shop_bill. */
function fakeDb(start: BillRecord | null = null, data: () => BillInputs = () => inputs()) {
  let record: (BillRecord & { claimId: string | null; rejections: number }) | null = start ? { ...start, claimId: null, rejections: 0 } : null;
  let n = 0;
  const finishes: BillOutcome[] = [];
  const logs: string[] = [];
  const divisions: { customerId: string; id: string; name: string }[] = [];
  const deps = {
    saveDivision: vi.fn(async (customerId: string, d: { id: string; name: string }) => {
      divisions.push({ customerId, ...d });
    }),
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
  return { deps, finishes, logs, divisions, get record() { return record; } };
}

type Created = { Id: string; DocNumber?: string; TotalAmt?: number };
function fakeQbo(
  over: {
    find?: FoundBill[];
    create?: () => Promise<Created>;
    items?: QboBillItem[];
    departments?: () => Promise<QboDepartment[]>;
    terms?: QboTerm[];
  } = {},
) {
  const create = over.create ?? (async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { Id: "900", DocNumber: "INV-7781", TotalAmt: 250 };
  });
  const createBill = vi.fn<(payload: QboBillPayload, requestId: string) => Promise<Created>>(() => create());
  const findBills = vi.fn(async () => over.find ?? []);
  const getItems = vi.fn(async (ids: string[]) =>
    (over.items ?? [{ Id: "500", Name: "DPF Cleaning", ExpenseAccountRef: { value: "70", name: "Cleaning COGS" } }]).filter((i) => ids.includes(i.Id)),
  );
  const listDepartments = vi.fn(over.departments ?? (async () => [{ Id: "3", Name: "RYDER INCOME" }, { Id: "4", Name: "RYDER COGS" }]));
  const listTerms = vi.fn(async () => over.terms ?? [{ Id: "1", Name: "Due on receipt" }, { Id: "3", Name: "Net 30" }]);
  const recentBillCustomFields = vi.fn(async () => []);
  const qbo = { createBill, findBills, getItems, listDepartments, listTerms, recentBillCustomFields };
  return { ...qbo, api: vi.fn(async () => qbo) };
}

const deps = (db: ReturnType<typeof fakeDb>, qbo: ReturnType<typeof fakeQbo>): BillRunDeps => ({ ...db.deps, qbo: qbo.api });

describe("runShopBill", () => {
  it("creates the bill once and records its id, number and total", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r).toEqual({ status: "created", message: "QuickBooks bill INV-7781 created ($250.00)." });
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    expect(qbo.createBill.mock.calls[0][1]).toBe(`bill-${WO}`);
    expect(db.record).toMatchObject({ status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 250 });
  });

  it("on the customer's first bill, finds its COGS division in QuickBooks, sends it and remembers it once", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    expect((await runShopBill(deps(db, qbo), WO)).status).toBe("created");
    expect(qbo.createBill.mock.calls[0][0].DepartmentRef).toEqual({ value: "4", name: "RYDER COGS" });
    expect(db.divisions).toEqual([{ customerId: "cccccccc-0000-4000-8000-000000000001", id: "4", name: "RYDER COGS" }]);
  });

  it("uses the remembered COGS division without asking QuickBooks again", async () => {
    const db = fakeDb(null, () => inputs({ division: { id: "4", name: "RYDER COGS" } }));
    const qbo = fakeQbo();
    await runShopBill(deps(db, qbo), WO);
    expect(qbo.listDepartments).not.toHaveBeenCalled();
    expect(db.deps.saveDivision).not.toHaveBeenCalled();
    expect(qbo.createBill.mock.calls[0][0].DepartmentRef).toEqual({ value: "4", name: "RYDER COGS" });
  });

  it("sends the bill without a Division when none or two match, or the lookup fails; nothing is remembered", async () => {
    for (const departments of [
      async () => [{ Id: "3", Name: "RYDER INCOME" }],
      async () => [{ Id: "4", Name: "RYDER COGS" }, { Id: "5", Name: "Ryder  cogs" }],
      async (): Promise<QboDepartment[]> => {
        throw new Error("boom");
      },
    ]) {
      const db = fakeDb();
      const qbo = fakeQbo({ departments });
      expect((await runShopBill(deps(db, qbo), WO)).status).toBe("created");
      expect(qbo.createBill.mock.calls[0][0].DepartmentRef).toBeUndefined();
      expect(db.divisions).toEqual([]);
    }
  });

  it("uses the QuickBooks term Net 30 when CDS chose no terms; the vendor's terms when there is none", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    await runShopBill(deps(db, qbo), WO);
    expect(qbo.createBill.mock.calls[0][0].SalesTermRef).toEqual({ value: "3", name: "Net 30" });

    const db2 = fakeDb();
    const qbo2 = fakeQbo({ terms: [{ Id: "1", Name: "Due on receipt" }] });
    await runShopBill(deps(db2, qbo2), WO);
    expect(qbo2.createBill.mock.calls[0][0].SalesTermRef).toBeUndefined();

    // Terms chosen in the setting win, and QuickBooks is not asked.
    const db3 = fakeDb(null, () => inputs({ setting: { deduction: null, since: null, termsId: "7", termsName: "Net 15" } }));
    const qbo3 = fakeQbo();
    await runShopBill(deps(db3, qbo3), WO);
    expect(qbo3.createBill.mock.calls[0][0].SalesTermRef).toEqual({ value: "7", name: "Net 15" });
    expect(qbo3.listTerms).not.toHaveBeenCalled();
  });

  it("two calls at the same moment (two CDS clicks) create one bill", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    const [a, b] = await Promise.all([runShopBill(deps(db, qbo), WO), runShopBill(deps(db, qbo), WO)]);
    expect(qbo.createBill).toHaveBeenCalledTimes(1);
    expect(db.deps.claim).toHaveBeenCalledTimes(2);
    expect([a, b].filter((r) => r.status === "created")).toHaveLength(1);
    const other = [a, b].find((r) => r.status !== "created")!;
    expect(other.status).toBe("failed");
  });

  it("never sends a second bill once one is recorded", async () => {
    const db = fakeDb({ status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 250, error: null, claimedAt: null, billCreatedAt: null });
    const qbo = fakeQbo();
    expect(await runShopBill(deps(db, qbo), WO)).toEqual({ status: "failed", message: "This work order already has QuickBooks bill INV-7781." });
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
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r).toEqual({ status: "failed", message: "QuickBooks refused the bill: Invalid Reference Id: Account assigned to this line is inactive" });
    expect(db.record).toMatchObject({ status: "failed", error: "QuickBooks refused the bill: Invalid Reference Id: Account assigned to this line is inactive" });
    expect(db.logs[0]).toContain("tid-1");
    refuse = false;
    const retry = await runShopBill(deps(db, qbo), WO);
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
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.message).toContain("Try again: a retry never creates a second bill");
    fail = false;
    await runShopBill(deps(db, qbo), WO);
    expect(qbo.createBill.mock.calls.map((c) => c[1])).toEqual([`bill-${WO}`, `bill-${WO}`]);
  });

  it("records a bill the portal already made for this order (found by number and vendor) instead of sending another", async () => {
    const db = fakeDb();
    const qbo = fakeQbo({ find: [{ Id: "777", DocNumber: "INV-7781", VendorRef: { value: "301" }, TotalAmt: 250, PrivateNote: "Portal WO-104321 | Shop invoice INV-7781" }] });
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r).toEqual({ status: "created", message: "QuickBooks bill INV-7781 was already in QuickBooks and is now recorded ($250.00)." });
    expect(qbo.createBill).not.toHaveBeenCalled();
    expect(db.record).toMatchObject({ status: "created", qbBillId: "777" });
  });

  it("does not send a bill when the shop's invoice number is already on another bill of that vendor", async () => {
    const db = fakeDb();
    const qbo = fakeQbo({ find: [{ Id: "555", DocNumber: "INV-7781", VendorRef: { value: "301" }, TotalAmt: 99, PrivateNote: "" }] });
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.message).toBe(
      "QuickBooks already has bill INV-7781 from Diesel Pros LLC ($99.00), not made for this order. Check it in QuickBooks; no bill was created.",
    );
    expect(qbo.createBill).not.toHaveBeenCalled();
    // A bill with the same number from another vendor is not in the way.
    const db2 = fakeDb();
    const qbo2 = fakeQbo({ find: [{ Id: "556", DocNumber: "INV-7781", VendorRef: { value: "999" }, TotalAmt: 250, PrivateNote: "" }] });
    expect((await runShopBill(deps(db2, qbo2), WO)).status).toBe("created");
  });

  it("reads the bill's QuickBooks items first and stops when one has no expense account; CDS fixes it and retries", async () => {
    const db = fakeDb();
    const items: QboBillItem[] = [{ Id: "500", Name: "DPF Cleaning" }];
    const qbo = fakeQbo({ items });
    const r = await runShopBill(deps(db, qbo), WO);
    const message =
      "QuickBooks item DPF Cleaning (SVC-DPF DPF cleaning) has no expense account, so it cannot go on a shop bill. Add its expense account in QuickBooks (Purchasing information), then Retry.";
    expect(r).toEqual({ status: "failed", message });
    expect(qbo.getItems).toHaveBeenCalledWith(["500"]);
    expect(qbo.createBill).not.toHaveBeenCalled();
    expect(db.record).toMatchObject({ status: "failed", error: message });
    expect(db.logs[0]).toBe(`rejected: ${message}`);
    // CDS adds the expense account in QuickBooks and retries: nothing was sent, so a new request id.
    items[0] = { Id: "500", Name: "DPF Cleaning", ExpenseAccountRef: { value: "70" } };
    expect((await runShopBill(deps(db, qbo), WO)).status).toBe("created");
    expect(qbo.createBill.mock.calls[0][1]).toBe(`bill-${WO}-r1`);
  });

  it("refuses an unlinked item before anything is claimed or sent", async () => {
    const db = fakeDb(null, () => inputs({ itemMap: { customer: {}, default: {} } }));
    const qbo = fakeQbo();
    expect(await runShopBill(deps(db, qbo), WO)).toEqual({
      status: "failed",
      message: "Fix these first: SVC-DPF DPF cleaning is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings.",
    });
    expect(db.deps.claim).not.toHaveBeenCalled();
    expect(qbo.api).not.toHaveBeenCalled();
  });

  it("does nothing until CDS turned shop bills on", async () => {
    const db = fakeDb(null, () => inputs({ setting: null }));
    const qbo = fakeQbo();
    expect(await runShopBill(deps(db, qbo), WO)).toEqual({ status: "failed", message: "QuickBooks bills are not set up yet." });
    expect(db.deps.claim).not.toHaveBeenCalled();
    expect(qbo.api).not.toHaveBeenCalled();
  });

  it("does nothing while a shop rate is TBD; CDS sees what to fix", async () => {
    const db = fakeDb(null, () => inputs({ lines: [{ catalogItemId: CLEAN, sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: null }] }));
    const qbo = fakeQbo();
    const manual = await runShopBill(deps(db, qbo), WO);
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
    expect((await runShopBill(deps(db, qbo), WO)).status).toBe("created");
    expect(qbo.api).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it("records a missing QuickBooks connection on the order without throwing", async () => {
    const db = fakeDb();
    const qbo = fakeQbo();
    qbo.api.mockRejectedValueOnce(new QboError("QuickBooks is not connected. Connect it in Admin > Settings.", 0, "Config"));
    const r = await runShopBill(deps(db, qbo), WO);
    expect(r).toEqual({ status: "failed", message: "QuickBooks is not connected. Connect it in Admin > Settings." });
    expect(db.record).toMatchObject({ status: "failed", error: "QuickBooks is not connected. Connect it in Admin > Settings." });
  });
});
