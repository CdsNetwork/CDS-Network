/**
 * M3: the shop's bill in CDS Inc's QuickBooks (src/lib/qbo/bill.ts). Pure: the bill payload
 * (the same amounts the shop sees, deductions included), when a bill may be created, and the
 * vendor suggested for a shop by name.
 *
 * Bills go by item (CDS, 2026-11-16): each line uses the QuickBooks item the customer's
 * invoice uses for it, so QuickBooks books it to that item's own expense account. The
 * shipping deduction has no item: it goes to one account CDS chooses.
 */
import { describe, expect, it } from "vitest";
import {
  BILL_SETTING_KEY,
  billSettingValue,
  billState,
  billTxnDate,
  buildBillPayload,
  itemsWithoutExpenseAccount,
  parseBillSetting,
  shouldAutoCreate,
  suggestVendor,
  type BillInputs,
  type BillLineSetting,
  type BillRecord,
} from "@/lib/qbo/bill";
import { shopPayable } from "@/lib/shop-deductions";

const deductionAccount = { kind: "account" as const, id: "88", name: "Freight Savings" };
const setting: BillLineSetting = { deduction: deductionAccount, termsId: null, termsName: null, since: null };

const CLEAN = "aaaaaaaa-0000-4000-8000-000000000001";
const GASKET = "aaaaaaaa-0000-4000-8000-000000000002";
const SHIP = "aaaaaaaa-0000-4000-8000-000000000003";

function inputs(over: Partial<BillInputs> = {}, wo: Partial<BillInputs["workOrder"]> = {}): BillInputs {
  return {
    workOrder: {
      id: "11111111-1111-4111-8111-111111111111",
      woNumber: 104321,
      status: "completed",
      completedAt: "2026-11-17T06:30:00Z", // 2026-11-16 in California
      shopInvoiceRef: "INV-7781",
      customerId: "cccccccc-0000-4000-8000-000000000001",
      customerName: "Ryder",
      poNumber: "0520772220",
      unitNumber: "U-55",
      shopName: "Diesel Pros Houston",
      shopInHouse: false,
      ...wo,
    },
    lines: [
      { catalogItemId: CLEAN, sku: "SVC-DPF", name: "DPF cleaning", description: null, qty: 2, shopUnitRate: 125.5 },
      { catalogItemId: GASKET, sku: "GSK-1", name: "Gasket", description: "V-band", qty: 3, shopUnitRate: 4.25 },
      { catalogItemId: SHIP, sku: "SVC-SHIP", name: "Shipping", description: null, qty: 1, shopUnitRate: 0 },
    ],
    deductions: [{ kind: "filter_shipping", filters: 2, unit_amount: -15, amount: -30 }],
    vendor: { qboVendorId: "301", qboVendorName: "Diesel Pros LLC" },
    setting,
    classId: "12",
    division: null,
    incomeDivisionName: "RYDER INCOME",
    itemMap: {
      // The cleaning is linked for this customer, the gasket for all customers; shipping has no link.
      customer: { [CLEAN]: { qboItemId: "501", qboItemName: "Ryder DPF Cleaning" } },
      default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" }, [GASKET]: { qboItemId: "610", qboItemName: "Gasket" } },
      otherCustomers: {},
    },
    ...over,
  };
}

const sum = (lines: { Amount: number }[]) => Math.round(lines.reduce((s, l) => s + l.Amount, 0) * 100) / 100;

describe("buildBillPayload: one line per item, on the item the customer invoice uses", () => {
  it("bills the same total the shop sees, deductions included", () => {
    const i = inputs();
    const r = buildBillPayload(i);
    if (!r.ok) throw new Error(r.problems.join(" "));
    const payable = shopPayable(
      i.lines.map((l) => ({ qty: l.qty, shop_unit_rate: l.shopUnitRate })),
      i.deductions,
    );
    expect(payable).toBe(233.75);
    expect(r.total).toBe(payable);
    expect(sum(r.payload.Line)).toBe(payable);
    // The $0 shipping line is left off (it needs no item link); the deduction is a negative line.
    expect(r.payload.Line).toHaveLength(3);
  });

  it("puts each line on its QuickBooks item (the customer's own link first) with Qty, the shop rate and the shop's class", () => {
    const r = buildBillPayload(inputs());
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.Line[0]).toEqual({
      DetailType: "ItemBasedExpenseLineDetail",
      Amount: 251,
      Description: "SVC-DPF DPF cleaning (2 x $125.50)",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "501", name: "Ryder DPF Cleaning" }, Qty: 2, UnitPrice: 125.5, ClassRef: { value: "12" }, BillableStatus: "NotBillable" },
    });
    expect(r.payload.Line[1]).toEqual({
      DetailType: "ItemBasedExpenseLineDetail",
      Amount: 12.75,
      Description: "GSK-1 Gasket - V-band (3 x $4.25)",
      ItemBasedExpenseLineDetail: { ItemRef: { value: "610", name: "Gasket" }, Qty: 3, UnitPrice: 4.25, ClassRef: { value: "12" }, BillableStatus: "NotBillable" },
    });
  });

  it("puts the shipping deduction on the account chosen for deductions, as one negative line", () => {
    const r = buildBillPayload(inputs());
    if (!r.ok) throw new Error(r.problems.join(" "));
    const d = r.payload.Line[2];
    expect(d).toEqual({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: -30,
      Description: expect.stringContaining("2 filters"),
      AccountBasedExpenseLineDetail: { AccountRef: { value: "88", name: "Freight Savings" }, ClassRef: { value: "12" }, BillableStatus: "NotBillable" },
    });
  });

  it("an item chosen for deductions (fallback) gets one item line with the filters as Qty", () => {
    const r = buildBillPayload(inputs({ setting: { ...setting, deduction: { kind: "item", id: "41", name: "Shipping credit" } }, classId: null }));
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.Line[2]).toMatchObject({
      DetailType: "ItemBasedExpenseLineDetail",
      Amount: -30,
      ItemBasedExpenseLineDetail: { ItemRef: { value: "41" }, Qty: 2, UnitPrice: -15, BillableStatus: "NotBillable" },
    });
    expect(sum(r.payload.Line)).toBe(r.total);
  });

  it("refuses a line with a shop amount whose item is not linked to a QuickBooks item, with the invoice's wording", () => {
    const r = buildBillPayload(inputs({ itemMap: { customer: {}, default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" } }, otherCustomers: {} } }));
    expect(r).toEqual({ ok: false, problems: ["GSK-1 Gasket is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings."] });
    const others = buildBillPayload(inputs({ itemMap: { customer: {}, default: { [CLEAN]: { qboItemId: "500", qboItemName: "DPF Cleaning" } }, otherCustomers: { [GASKET]: true } } }));
    expect(others.ok).toBe(false);
    if (!others.ok) expect(others.problems[0]).toBe(
      "GSK-1 Gasket is not linked to a QuickBooks item for Ryder (it is linked for other customers only). Link it for Ryder or for all customers on Admin > QuickBooks mappings.",
    );
  });

  it("names each unlinked item once, even on two lines", () => {
    const line = { catalogItemId: GASKET, sku: "GSK-1", name: "Gasket", description: null, qty: 1, shopUnitRate: 5 };
    const r = buildBillPayload(inputs({ lines: [line, line], deductions: [], itemMap: { customer: {}, default: {}, otherCustomers: {} } }));
    expect(r).toEqual({ ok: false, problems: ["GSK-1 Gasket is not linked to a QuickBooks item. Link it on Admin > QuickBooks mappings."] });
  });

  it("without a deduction account: an order with a deduction waits, one without is billed", () => {
    const noAccount = { ...setting, deduction: null };
    const withDeduction = buildBillPayload(inputs({ setting: noAccount }));
    expect(withDeduction.ok).toBe(false);
    if (!withDeduction.ok) expect(withDeduction.problems).toEqual(["Choose the account for shipping deductions on Admin > QuickBooks mappings > Shop bills."]);
    const without = buildBillPayload(inputs({ setting: noAccount, deductions: [] }));
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.total).toBe(263.75);
    // A $0 deduction needs no account either.
    expect(buildBillPayload(inputs({ setting: noAccount, deductions: [{ kind: "filter_shipping", filters: 0, unit_amount: -15, amount: 0 }] })).ok).toBe(true);
  });

  it("goes to the shop's vendor with the shop's invoice number, the date it completed and the order in the memo", () => {
    const r = buildBillPayload(inputs());
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.VendorRef).toEqual({ value: "301", name: "Diesel Pros LLC" });
    expect(r.payload.DocNumber).toBe("INV-7781");
    expect(r.payload.TxnDate).toBe("2026-11-16");
    expect(r.payload.PrivateNote).toContain("Portal WO-104321");
    expect(r.payload.PrivateNote).toContain("PO 0520772220");
    expect(r.payload.PrivateNote).toContain("Ryder");
    expect(r.payload.SalesTermRef).toBeUndefined();
  });

  it("carries the customer's COGS division when it is known", () => {
    const r = buildBillPayload(inputs({ division: { id: "4", name: "RYDER COGS" } }));
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.DepartmentRef).toEqual({ value: "4", name: "RYDER COGS" });
    const none = buildBillPayload(inputs());
    if (!none.ok) throw new Error(none.problems.join(" "));
    expect(none.payload.DepartmentRef).toBeUndefined();
  });

  it("adds the terms when they are part of the setting", () => {
    const r = buildBillPayload(inputs({ setting: { ...setting, termsId: "3", termsName: "Net 30" } }));
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.SalesTermRef).toEqual({ value: "3", name: "Net 30" });
  });

  it("uses WO-<number> when the shop gave no invoice number, and says so in the memo", () => {
    const r = buildBillPayload(inputs({}, { shopInvoiceRef: "  " }));
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.DocNumber).toBe("WO-104321");
    expect(r.payload.PrivateNote).toContain("No shop invoice number");
  });

  it("cuts a long invoice number to the 21 characters QuickBooks allows and keeps it whole in the memo", () => {
    const ref = "SHOP-INVOICE-2026-11-000123";
    const r = buildBillPayload(inputs({}, { shopInvoiceRef: ref }));
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(r.payload.DocNumber).toBe(ref.slice(0, 21));
    expect(r.payload.PrivateNote).toContain(`Shop invoice ${ref}`);
  });

  it("refuses a bill with an unknown amount (TBD shop rate)", () => {
    const r = buildBillPayload(inputs({ lines: [{ catalogItemId: CLEAN, sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: null }] }));
    expect(r).toEqual({ ok: false, problems: ["The shop rate for REC-DPF Recon DPF is not set yet (TBD). Enter it on the line."] });
  });

  it("refuses a shop without a QuickBooks vendor, and a total of $0 or less", () => {
    const noVendor = buildBillPayload(inputs({ vendor: null }));
    expect(noVendor.ok).toBe(false);
    if (!noVendor.ok) expect(noVendor.problems[0]).toBe("Diesel Pros Houston is not linked to a QuickBooks vendor. Link it on Admin > QuickBooks mappings.");
    const zero = buildBillPayload(inputs({ lines: [{ catalogItemId: CLEAN, sku: "X", name: "x", description: null, qty: 1, shopUnitRate: 20 }] }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.problems[0]).toMatch(/^The shop total is -\$10\.00/);
  });
});

describe("itemsWithoutExpenseAccount: QuickBooks items that cannot go on a bill", () => {
  it("names the item lines whose QuickBooks item has no expense account", () => {
    const r = buildBillPayload(inputs());
    if (!r.ok) throw new Error(r.problems.join(" "));
    const items = [
      { Id: "501", Name: "Ryder DPF Cleaning", ExpenseAccountRef: { value: "70", name: "CDS Cleaning Services" } },
      { Id: "610", Name: "Gasket", ExpenseAccountRef: { value: "" } },
    ];
    expect(itemsWithoutExpenseAccount(r.payload, items)).toEqual([
      "QuickBooks item Gasket (GSK-1 Gasket) has no expense account, so it cannot go on a shop bill. Add its expense account in QuickBooks (Purchasing information), then Retry.",
    ]);
    expect(itemsWithoutExpenseAccount(r.payload, [items[0], { Id: "610", Name: "Gasket", ExpenseAccountRef: { value: "71" } }])).toEqual([]);
  });

  it("leaves items QuickBooks did not return to QuickBooks itself", () => {
    const r = buildBillPayload(inputs());
    if (!r.ok) throw new Error(r.problems.join(" "));
    expect(itemsWithoutExpenseAccount(r.payload, [])).toEqual([]);
  });
});

describe("billState: when a bill is created", () => {
  const none: BillRecord | null = null;

  it("completed with every shop amount known: ready, and created automatically", () => {
    const s = billState(inputs(), none);
    expect(s.kind).toBe("ready");
    expect(shouldAutoCreate(s, none)).toBe(true);
  });

  it("completed with a TBD rate: waits; created once CDS sets the last rate", () => {
    const tbd = inputs({ lines: [{ catalogItemId: CLEAN, sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: null }] });
    const s = billState(tbd, none);
    expect(s.kind).toBe("blocked");
    expect(shouldAutoCreate(s, none)).toBe(false);
    const set = inputs({ lines: [{ catalogItemId: CLEAN, sku: "REC-DPF", name: "Recon DPF", description: null, qty: 1, shopUnitRate: 300 }] });
    expect(shouldAutoCreate(billState(set, none), none)).toBe(true);
  });

  it("invoiced early (completion went straight to Invoiced): ready", () => {
    const s = billState(inputs({}, { status: "invoiced" }), none);
    expect(s.kind).toBe("ready");
  });

  it("invoiced before the shop completed: nothing yet", () => {
    expect(billState(inputs({}, { status: "invoiced", completedAt: null }), none).kind).toBe("none");
    expect(billState(inputs({}, { status: "in_process", completedAt: null }), none).kind).toBe("none");
  });

  it("cancelled: never", () => {
    const s = billState(inputs({}, { status: "cancelled" }), none);
    expect(s.kind).toBe("none");
    expect(shouldAutoCreate(s, none)).toBe(false);
  });

  it("CDS's own shop: never", () => {
    expect(billState(inputs({}, { shopInHouse: true }), none).kind).toBe("none");
  });

  it("completed before bills were turned on: no automatic bill (CDS typed those by hand), the button still works", () => {
    const on = { ...setting, since: "2026-11-20T00:00:00Z" };
    const old = billState(inputs({ setting: on }), none);
    expect(old).toMatchObject({ kind: "ready", beforeSince: true });
    expect(shouldAutoCreate(old, none)).toBe(false);
    const fresh = billState(inputs({ setting: on }, { completedAt: "2026-11-20T08:00:00Z" }), none);
    expect(shouldAutoCreate(fresh, none)).toBe(true);
  });

  it("shop bills not turned on yet: not set up, nothing runs", () => {
    const s = billState(inputs({ setting: null }), none);
    expect(s.kind).toBe("not_set_up");
    expect(shouldAutoCreate(s, none)).toBe(false);
  });

  it("a bill exists: shown, never created again", () => {
    const rec: BillRecord = { status: "created", qbBillId: "900", qbBillNumber: "INV-7781", qbTotal: 233.75, error: null, claimedAt: null, billCreatedAt: "2026-11-17T07:00:00Z" };
    const s = billState(inputs(), rec);
    expect(s).toMatchObject({ kind: "created", billId: "900", number: "INV-7781", total: 233.75, changedTotal: null });
    expect(shouldAutoCreate(s, rec)).toBe(false);
    // The shop total changed after the bill was made: CDS is told.
    expect(billState(inputs({ deductions: [] }), rec)).toMatchObject({ kind: "created", changedTotal: 263.75 });
    // A cancelled order keeps showing its bill.
    expect(billState(inputs({}, { status: "cancelled" }), rec).kind).toBe("created");
  });

  it("an unlinked item or a missing deduction account: blocked, nothing runs", () => {
    const s = billState(inputs({ setting: { ...setting, deduction: null } }), none);
    expect(s).toMatchObject({ kind: "blocked", problems: ["Choose the account for shipping deductions on Admin > QuickBooks mappings > Shop bills."] });
    expect(shouldAutoCreate(s, none)).toBe(false);
  });

  it("QuickBooks refused it before: CDS retries by hand, no automatic retry", () => {
    const rec: BillRecord = { status: "failed", qbBillId: null, qbBillNumber: null, qbTotal: null, error: "Invalid account", claimedAt: null, billCreatedAt: null };
    const s = billState(inputs(), rec);
    expect(s).toMatchObject({ kind: "ready", lastError: "Invalid account" });
    expect(shouldAutoCreate(s, rec)).toBe(false);
  });

  it("being created right now: creating (a stale claim older than 5 minutes is ready again)", () => {
    const now = new Date("2026-11-17T07:00:00Z");
    const rec: BillRecord = { status: "creating", qbBillId: null, qbBillNumber: null, qbTotal: null, error: null, claimedAt: "2026-11-17T06:59:00Z", billCreatedAt: null };
    expect(billState(inputs(), rec, now).kind).toBe("creating");
    expect(billState(inputs(), { ...rec, claimedAt: "2026-11-17T06:50:00Z" }, now).kind).toBe("ready");
  });
});

describe("parseBillSetting", () => {
  it("reads the stored setting: turned on (since), optional deduction account and terms", () => {
    expect(BILL_SETTING_KEY).toBe("qbo_bill_line");
    expect(parseBillSetting({ mode: "item", since: "2026-11-20T00:00:00.000Z" })).toEqual({ deduction: null, termsId: null, termsName: null, since: "2026-11-20T00:00:00.000Z" });
    const full = {
      mode: "item",
      deduction: { kind: "account", id: "88", name: "Freight Savings" },
      terms_id: "3",
      terms_name: "Net 30",
      since: "2026-11-20T00:00:00.000Z",
    };
    expect(parseBillSetting(full)).toEqual({ deduction: { kind: "account", id: "88", name: "Freight Savings" }, termsId: "3", termsName: "Net 30", since: "2026-11-20T00:00:00.000Z" });
    expect(billSettingValue(parseBillSetting(full)!)).toEqual(full);
    expect(billSettingValue({ deduction: null, since: "2026-11-20T00:00:00.000Z" })).toEqual({ mode: "item", since: "2026-11-20T00:00:00.000Z" });
  });

  it("reads the earlier single account or item choice as the deduction account", () => {
    expect(parseBillSetting({ kind: "account", id: "88", name: "Subcontractors", since: "2026-11-20T00:00:00.000Z" })).toEqual({
      deduction: { kind: "account", id: "88", name: "Subcontractors" },
      termsId: null,
      termsName: null,
      since: "2026-11-20T00:00:00.000Z",
    });
    expect(parseBillSetting({ kind: "item", id: "41", name: "Cost" })?.deduction).toEqual({ kind: "item", id: "41", name: "Cost" });
  });

  it("drops a deduction choice that is not valid, keeping bills on", () => {
    expect(parseBillSetting({ mode: "item", since: "2026-11-20T00:00:00.000Z", deduction: { kind: "class", id: "1", name: "x" } })?.deduction).toBeNull();
  });

  it("treats an empty or absent setting as not turned on", () => {
    for (const v of [null, undefined, true, {}, [], { kind: "account" }, { kind: "class", id: "1", name: "x" }, { kind: "item", id: "abc", name: "x" }, { since: "not a date" }]) {
      expect(parseBillSetting(v)).toBeNull();
    }
  });
});

describe("billTxnDate", () => {
  it("is the California date the shop completed the job", () => {
    expect(billTxnDate("2026-11-17T06:30:00Z")).toBe("2026-11-16");
    expect(billTxnDate("2026-11-17T09:30:00Z")).toBe("2026-11-17");
  });
});

describe("suggestVendor", () => {
  const vendors = [
    { Id: "1", DisplayName: "Diesel Pros LLC", CompanyName: "Diesel Pros LLC" },
    { Id: "2", DisplayName: "Enviromotive Inc." },
    { Id: "3", DisplayName: "CDS Houston (vendor)", CompanyName: "Houston Filter Works" },
    { Id: "4", DisplayName: "Old Shop", Active: false },
    { Id: "5", DisplayName: "Twin Cities Diesel" },
    { Id: "6", DisplayName: "Twin Cities Diesel Repair" },
  ];

  it("matches the shop name, ignoring case, punctuation and LLC / Inc", () => {
    expect(suggestVendor("Enviromotive", vendors)?.Id).toBe("2");
    expect(suggestVendor("DIESEL PROS", vendors)?.Id).toBe("1");
    expect(suggestVendor("Houston Filter Works", vendors)?.Id).toBe("3");
  });

  it("suggests nothing for no match, an inactive vendor, or two equally good ones", () => {
    expect(suggestVendor("Nowhere Shop", vendors)).toBeNull();
    expect(suggestVendor("Old Shop", vendors)).toBeNull();
    expect(suggestVendor("Twin Cities", vendors)).toBeNull();
    // An exact name still wins over a longer one.
    expect(suggestVendor("Twin Cities Diesel", vendors)?.Id).toBe("5");
  });
});
