/**
 * BUG (CDS, 2026-11-17): shop bills put the unit (Fleet Number) and the PO in the bill memo.
 * CDS has custom fields on bills, "Fleet Number" and "P.O. Number" (on invoices the PO field
 * is "PO Number"). The bill now fills those fields, learned by name from recent bills read
 * with include=enhancedAllCustomFields, and is created with that include. A field that
 * cannot be found is left off and its value stays in the memo; it never blocks the bill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillInputs, QboBillPayload } from "@/lib/qbo/bill";
import { runShopBill, type BillOutcome, type BillRunDeps } from "@/lib/qbo/bill-run";
import { billCustomFieldDefs } from "@/lib/qbo/custom-fields";
import { QboError } from "@/lib/qbo/client";

const { qboApi, qboRequest } = vi.hoisted(() => ({ qboApi: vi.fn(), qboRequest: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi }));
vi.mock("@/lib/qbo/client", async (orig) => ({ ...(await orig<typeof import("@/lib/qbo/client")>()), qboRequest }));

const WO = "11111111-1111-4111-8111-111111111111";
const CLEAN = "aaaaaaaa-0000-4000-8000-000000000001";

function inputs(over: Partial<BillInputs["workOrder"]> = {}): BillInputs {
  return {
    workOrder: {
      id: WO,
      woNumber: 101928,
      status: "completed",
      completedAt: "2026-11-17T06:30:00Z",
      shopInvoiceRef: "INV-7781",
      customerId: "cccccccc-0000-4000-8000-000000000001",
      customerName: "Ryder",
      poNumber: "0520772220",
      unitNumber: "T-4471",
      shopName: "Diesel Pros Houston",
      shopInHouse: false,
      ...over,
    },
    lines: [{ catalogItemId: CLEAN, sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125 }],
    deductions: [],
    vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
    setting: { deduction: null, termsId: "3", termsName: "Net 30", since: null },
    classId: null,
    division: { id: "4", name: "RYDER COGS" },
    incomeDivisionName: "RYDER INCOME",
    itemMap: { customer: {}, default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" } } },
    approvedAt: "2026-11-17T07:00:00Z",
  };
}

/** Recent bills as CDS's QuickBooks returns them with include=enhancedAllCustomFields (shape only, made-up values). */
const cdsRecentBills = [
  {
    Id: "77",
    CustomField: [
      { DefinitionId: "2800000000000120140", Name: "Fleet Number", Type: "StringType", StringValue: "A-1" },
      { DefinitionId: "513141", Name: "P.O. Number", Type: "StringType", StringValue: "P-1" },
    ],
  },
  { Id: "76", CustomField: [{ DefinitionId: "513141", Name: "P.O. Number", Type: "StringType" }] },
];

function harness(fields: () => Promise<{ CustomField?: { DefinitionId?: string; Name?: string }[] }[]>, wo: Partial<BillInputs["workOrder"]> = {}) {
  const logs: string[] = [];
  const finishes: BillOutcome[] = [];
  const createBill = vi.fn<(p: QboBillPayload, r: string) => Promise<{ Id: string; DocNumber: string; TotalAmt: number }>>(async () => ({ Id: "900", DocNumber: "INV-7781", TotalAmt: 250 }));
  const recentBillCustomFields = vi.fn(fields);
  const qbo = {
    createBill,
    recentBillCustomFields,
    findBills: vi.fn(async () => []),
    getItems: vi.fn(async () => [{ Id: "500", Name: "DPF Cleaning", ExpenseAccountRef: { value: "70" } }]),
    listDepartments: vi.fn(async () => []),
    listTerms: vi.fn(async () => []),
  };
  const deps: BillRunDeps = {
    load: async () => ({ inputs: inputs(wo), record: null }),
    claim: async () => ({ claimId: "c1", requestId: `bill-${WO}` }),
    finish: async (_w, _c, o) => {
      finishes.push(o);
    },
    qbo: vi.fn(async () => qbo),
    saveDivision: async () => {},
    log: async (status, _id, note) => {
      logs.push(`${status}: ${note ?? ""}`);
    },
  };
  return { deps, qbo, logs, finishes, sent: () => createBill.mock.calls[0][0] };
}

describe("billCustomFieldDefs: the bill's Fleet Number and PO fields, by name", () => {
  const defs = (names: string[]) => billCustomFieldDefs([{ CustomField: names.map((n, i) => ({ DefinitionId: String(i + 1), Name: n })) }]);

  it("finds CDS's bill fields", () => {
    expect(defs(["Fleet Number", "P.O. Number"])).toEqual({
      fleet: { id: "1", name: "Fleet Number", classic: false },
      po: { id: "2", name: "P.O. Number", classic: false },
    });
  });

  it("matches the names loosely, ignoring case, dots, spaces and #", () => {
    for (const n of ["P.O. Number", "PO Number", "po number", "PO #", "PO", "P.O.", "PO No.", "Purchase Order", "Purchase Order Number"]) {
      expect(defs([n]).po?.name, n).toBe(n);
    }
    for (const n of ["Fleet Number", "fleet number", "Fleet #", "Fleet", "Unit", "Unit Number", "Unit #"]) {
      expect(defs([n]).fleet?.name, n).toBe(n);
    }
  });

  it("does not take unrelated fields", () => {
    expect(defs(["Sales Rep", "Project", "Reference", "Port", "Unit Price"])).toEqual({ fleet: null, po: null });
    expect(billCustomFieldDefs([])).toEqual({ fleet: null, po: null });
  });
});

describe("runShopBill fills the bill's custom fields", () => {
  it("sends Fleet Number and P.O. Number as custom fields and no longer repeats them in the memo", async () => {
    const h = harness(async () => cdsRecentBills);
    const r = await runShopBill(h.deps, WO);
    expect(r.status).toBe("created");
    const sent = h.sent();
    expect(sent.CustomField).toEqual([
      { DefinitionId: "2800000000000120140", Name: "Fleet Number", Type: "StringType", StringValue: "T-4471" },
      { DefinitionId: "513141", Name: "P.O. Number", Type: "StringType", StringValue: "0520772220" },
    ]);
    expect(sent.PrivateNote).toBe("Portal WO-101928 | Shop invoice INV-7781 | Ryder");
  });

  it("leaves a field without a definition off and keeps that value in the memo, with a note", async () => {
    const h = harness(async () => [{ CustomField: [{ DefinitionId: "513141", Name: "P.O. Number" }] }]);
    await runShopBill(h.deps, WO);
    const sent = h.sent();
    expect(sent.CustomField).toEqual([{ DefinitionId: "513141", Name: "P.O. Number", Type: "StringType", StringValue: "0520772220" }]);
    expect(sent.PrivateNote).toBe("Portal WO-101928 | Shop invoice INV-7781 | Ryder | Unit T-4471");
    expect(h.logs.join("\n")).toMatch(/Fleet Number/);
  });

  it("never blocks the bill when the fields cannot be read: both values stay in the memo", async () => {
    const h = harness(async () => {
      throw new Error("timeout");
    });
    const r = await runShopBill(h.deps, WO);
    expect(r.status).toBe("created");
    const sent = h.sent();
    expect(sent.CustomField).toBeUndefined();
    expect(sent.PrivateNote).toBe("Portal WO-101928 | Shop invoice INV-7781 | Ryder | PO 0520772220 | Unit T-4471");
  });

  it("does not read the fields when the order has no PO and no unit", async () => {
    const h = harness(async () => cdsRecentBills, { poNumber: null, unitNumber: "  " });
    await runShopBill(h.deps, WO);
    expect(h.qbo.recentBillCustomFields).not.toHaveBeenCalled();
    expect(h.sent().CustomField).toBeUndefined();
    expect(h.sent().PrivateNote).toBe("Portal WO-101928 | Shop invoice INV-7781 | Ryder");
  });

  it("an expired token while reading the fields refreshes it and sends once", async () => {
    let first = true;
    const h = harness(async () => {
      if (first) {
        first = false;
        throw new QboError("expired", 401);
      }
      return cdsRecentBills;
    });
    const r = await runShopBill(h.deps, WO);
    expect(r.status).toBe("created");
    expect(h.qbo.createBill).toHaveBeenCalledTimes(1);
    expect(h.sent().CustomField).toHaveLength(2);
  });
});

describe("QuickBooks calls for bill custom fields (src/lib/qbo/api.ts)", () => {
  const conn = { environment: "production", realmId: "R1", accessToken: "t", astEnabled: null };
  beforeEach(() => qboRequest.mockReset());

  it("reads recent bills with include=enhancedAllCustomFields", async () => {
    qboRequest.mockResolvedValue({ QueryResponse: { Bill: cdsRecentBills } });
    const { recentBillCustomFields } = await import("@/lib/qbo/api");
    expect(await recentBillCustomFields(conn as never)).toEqual(cdsRecentBills);
    const [, method, path, opts] = qboRequest.mock.calls[0];
    expect([method, path]).toEqual(["GET", "query"]);
    expect(opts.query.include).toBe("enhancedAllCustomFields");
    expect(opts.query.query).toMatch(/^select \* from Bill orderby MetaData\.LastUpdatedTime desc maxresults 20$/i);
  });

  it("creates the bill with include=enhancedAllCustomFields", async () => {
    qboRequest.mockResolvedValue({ Bill: { Id: "900" } });
    const { createBill } = await import("@/lib/qbo/api");
    await createBill(conn as never, { Line: [] } as unknown as QboBillPayload, "bill-x");
    const [, method, path, opts] = qboRequest.mock.calls[0];
    expect([method, path]).toEqual(["POST", "bill"]);
    expect(opts.query).toEqual({ include: "enhancedAllCustomFields" });
    expect(opts.requestId).toBe("bill-x");
  });

  it("keeps the learned bill fields in the lists cache: a second bill does not read them again", async () => {
    qboRequest.mockResolvedValue({ QueryResponse: { Bill: cdsRecentBills } });
    const { cachedBillCustomFields, clearQboListsCache } = await import("@/lib/qbo/lists");
    clearQboListsCache();
    await cachedBillCustomFields(conn as never);
    await cachedBillCustomFields(conn as never);
    expect(qboRequest).toHaveBeenCalledTimes(1);
  });
});
