import { money } from "@/lib/format";
import { deductionLabel, shopPayable, type ShopDeduction } from "@/lib/shop-deductions";
import { cents } from "./invoice";

/**
 * The shop's bill in CDS Inc's QuickBooks (M3). Pure: no database, no network.
 *
 * Bill fields: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill
 *   * VendorRef: the shop's QuickBooks vendor (qbo_affiliate_vendor, linked by CDS on Admin >
 *     QuickBooks mappings).
 *   * DocNumber: the shop's invoice number (work_orders.affiliate_invoice_ref, required when the
 *     shop completes the job). QuickBooks allows 21 characters: a longer number is cut there
 *     and kept whole in the memo. Without one: "WO-<number>", said in the memo.
 *   * TxnDate: the California date the shop completed the job.
 *   * Line: one line per work order line at the shop rate, plus the (negative) deductions, so
 *     the bill total is exactly what the shop sees in the portal (shopPayable). Lines of $0
 *     are left off. Every line goes to the one expense account (AccountBasedExpenseLineDetail)
 *     or product/service item (ItemBasedExpenseLineDetail) CDS chose (app_settings
 *     qbo_bill_line), with the shop's Class (qbo_affiliate_class) on each line: bills carry
 *     the class per line.
 *   * SalesTermRef: the terms, when they are part of that setting; else the vendor's default.
 */

/** app_settings key of the one account or item every bill line goes to. Unset: bills are off. */
export const BILL_SETTING_KEY = "qbo_bill_line";

export type BillLineSetting = {
  kind: "account" | "item";
  id: string;
  name: string;
  termsId?: string | null;
  termsName?: string | null;
  /**
   * When bills were turned on. Orders the shop completed before then get no automatic bill
   * (CDS typed those by hand); CDS can still create one with the button.
   */
  since?: string | null;
};

const QBO_ID = /^\d{1,50}$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The stored setting, or null when it is missing or not a valid choice. */
export function parseBillSetting(value: unknown): BillLineSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  const id = str(v.id);
  const name = str(v.name);
  if ((kind !== "account" && kind !== "item") || !QBO_ID.test(id) || !name) return null;
  const termsId = str(v.terms_id);
  const since = str(v.since);
  return {
    kind,
    id,
    name,
    termsId: QBO_ID.test(termsId) ? termsId : null,
    termsName: QBO_ID.test(termsId) ? str(v.terms_name) || null : null,
    since: since && Number.isFinite(Date.parse(since)) ? since : null,
  };
}

/** The stored form of a setting (app_settings.value). */
export function billSettingValue(s: BillLineSetting): Record<string, string> {
  return {
    kind: s.kind,
    id: s.id,
    name: s.name,
    ...(s.termsId ? { terms_id: s.termsId, terms_name: s.termsName ?? "" } : {}),
    ...(s.since ? { since: s.since } : {}),
  };
}

export type BillWorkOrder = {
  id: string;
  woNumber: number;
  status: string;
  completedAt: string | null;
  /** work_orders.affiliate_invoice_ref: the shop's invoice or reference number. */
  shopInvoiceRef: string | null;
  customerName: string;
  poNumber: string | null;
  unitNumber: string | null;
  shopName: string;
  shopInHouse: boolean;
};

export type BillLine = { sku: string; name: string; description: string | null; qty: number; shopUnitRate: number | null };

export type VendorLink = { qboVendorId: string; qboVendorName: string };

export type BillInputs = {
  workOrder: BillWorkOrder;
  lines: BillLine[];
  deductions: ShopDeduction[];
  vendor: VendorLink | null;
  setting: BillLineSetting | null;
  /** qbo_affiliate_class.qbo_class_id of the shop. */
  classId: string | null;
};

type Ref = { value: string; name?: string };

export type QboBillLine =
  | {
      DetailType: "AccountBasedExpenseLineDetail";
      Amount: number;
      Description: string;
      AccountBasedExpenseLineDetail: { AccountRef: Ref; ClassRef?: Ref; BillableStatus: "NotBillable" };
    }
  | {
      DetailType: "ItemBasedExpenseLineDetail";
      Amount: number;
      Description: string;
      ItemBasedExpenseLineDetail: { ItemRef: Ref; Qty: number; UnitPrice: number; ClassRef?: Ref; BillableStatus: "NotBillable" };
    };

export type QboBillPayload = {
  VendorRef: Ref;
  TxnDate: string;
  DocNumber: string;
  PrivateNote: string;
  SalesTermRef?: Ref;
  Line: QboBillLine[];
};

export type BillBuild = { ok: true; payload: QboBillPayload; total: number } | { ok: false; problems: string[] };

/** QuickBooks limits: Bill.DocNumber 21, PrivateNote 4000, line Description 4000. */
const DOC_NUMBER_MAX = 21;
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

const pacificDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

/** The California date ("YYYY-MM-DD") of a timestamp: the bill date. */
export function billTxnDate(at: string | Date): string {
  return pacificDate.format(typeof at === "string" ? new Date(at) : at);
}

/** The shop's total for these inputs (the same function the shop's page uses). */
export function billTotal(i: Pick<BillInputs, "lines" | "deductions">): number {
  return shopPayable(
    i.lines.map((l) => ({ qty: l.qty, shop_unit_rate: l.shopUnitRate })),
    i.deductions,
  );
}

/** The shop's invoice number as the bill number, and what the memo should say about it. */
function docNumber(wo: BillWorkOrder): { doc: string; note: string } {
  const ref = wo.shopInvoiceRef?.trim() ?? "";
  if (!ref) return { doc: `WO-${wo.woNumber}`, note: "No shop invoice number" };
  return { doc: clip(ref, DOC_NUMBER_MAX), note: `Shop invoice ${ref}` };
}

export function buildBillPayload(i: BillInputs): BillBuild {
  const { workOrder: wo, setting } = i;
  const problems: string[] = [];
  if (!setting) problems.push("QuickBooks bills are not set up yet.");
  if (!i.vendor?.qboVendorId?.trim()) {
    problems.push(`${wo.shopName} is not linked to a QuickBooks vendor. Link it on Admin > QuickBooks mappings.`);
  }
  for (const l of i.lines) {
    if (l.shopUnitRate === null || !Number.isFinite(Number(l.shopUnitRate))) {
      problems.push(`The shop rate for ${l.sku} ${l.name} is not set yet (TBD). Enter it on the line.`);
    }
  }
  if (!i.lines.length) problems.push("The work order has no lines to bill.");
  if (problems.length || !setting || !i.vendor) return { ok: false, problems };

  const total = billTotal(i);
  if (!(total > 0)) {
    return { ok: false, problems: [`The shop total is ${money(total)}, so there is nothing to bill. Enter a credit in QuickBooks if one is owed.`] };
  }

  const classRef = i.classId?.trim() ? { ClassRef: { value: i.classId.trim() } } : {};
  const line = (amount: number, description: string, qty: number, unitPrice: number): QboBillLine =>
    setting.kind === "account"
      ? {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: amount,
          Description: clip(description, 4000),
          AccountBasedExpenseLineDetail: { AccountRef: { value: setting.id, name: setting.name }, ...classRef, BillableStatus: "NotBillable" },
        }
      : {
          DetailType: "ItemBasedExpenseLineDetail",
          Amount: amount,
          Description: clip(description, 4000),
          ItemBasedExpenseLineDetail: { ItemRef: { value: setting.id, name: setting.name }, Qty: qty, UnitPrice: unitPrice, ...classRef, BillableStatus: "NotBillable" },
        };

  const lines: QboBillLine[] = [];
  for (const l of i.lines) {
    const rate = Number(l.shopUnitRate);
    const amount = cents(l.qty * rate);
    if (amount === 0) continue;
    const text = [`${l.sku} ${l.name}`.trim(), l.description?.trim()].filter(Boolean).join(" - ");
    lines.push(line(amount, `${text} (${l.qty} x ${money(rate)})`, l.qty, rate));
  }
  for (const d of i.deductions) {
    if (!d.amount) continue;
    lines.push(line(cents(d.amount), deductionLabel(d), d.filters, d.unit_amount));
  }

  const { doc, note } = docNumber(wo);
  const po = wo.poNumber?.trim();
  const unit = wo.unitNumber?.trim();
  return {
    ok: true,
    total,
    payload: {
      VendorRef: { value: i.vendor.qboVendorId.trim(), name: i.vendor.qboVendorName },
      TxnDate: billTxnDate(wo.completedAt ?? new Date()),
      DocNumber: doc,
      PrivateNote: clip(
        [`Portal WO-${wo.woNumber}`, note, wo.customerName, po && `PO ${po}`, unit && `Unit ${unit}`].filter(Boolean).join(" | "),
        4000,
      ),
      ...(setting.termsId ? { SalesTermRef: { value: setting.termsId, ...(setting.termsName ? { name: setting.termsName } : {}) } } : {}),
      Line: lines,
    },
  };
}

// ---------------------------------------------------------------- when

/** public.qbo_shop_bills, as read by CDS. */
export type BillRecord = {
  status: "creating" | "created" | "failed";
  qbBillId: string | null;
  qbBillNumber: string | null;
  qbTotal: number | null;
  error: string | null;
  claimedAt: string | null;
  billCreatedAt: string | null;
};

/** The statuses of an order the shop has completed (completion may go straight to Invoiced). */
const DONE = ["completed", "delivered", "ready_to_invoice", "invoiced"];

/** A claim older than this has expired (public.qbo_claim_shop_bill). */
export const CLAIM_EXPIRES_MS = 5 * 60 * 1000;

export type BillState =
  /** No bill for this order: not completed yet, cancelled, or CDS's own shop. */
  | { kind: "none" }
  /** Completed, but CDS has not chosen the account or item yet. */
  | { kind: "not_set_up" }
  | { kind: "creating" }
  | { kind: "created"; billId: string; number: string | null; total: number | null; at: string | null; changedTotal: number | null }
  /** Completed, but something must be fixed first (vendor link, a TBD shop rate). */
  | { kind: "blocked"; problems: string[]; lastError: string | null }
  | {
      kind: "ready";
      payload: QboBillPayload;
      total: number;
      lastError: string | null;
      /** Completed before bills were turned on: no automatic bill, CDS decides. */
      beforeSince: boolean;
    };

export function billState(i: BillInputs, record: BillRecord | null, now: Date = new Date()): BillState {
  if (record?.status === "created" && record.qbBillId) {
    const current = billTotal(i);
    const changed = record.qbTotal !== null && i.lines.every((l) => l.shopUnitRate !== null) && cents(current) !== cents(Number(record.qbTotal));
    return {
      kind: "created",
      billId: record.qbBillId,
      number: record.qbBillNumber,
      total: record.qbTotal,
      at: record.billCreatedAt,
      changedTotal: changed ? current : null,
    };
  }
  const wo = i.workOrder;
  if (wo.shopInHouse || wo.status === "cancelled" || !wo.completedAt || !DONE.includes(wo.status)) return { kind: "none" };
  if (!i.setting) return { kind: "not_set_up" };
  if (record?.status === "creating" && record.claimedAt && now.getTime() - Date.parse(record.claimedAt) < CLAIM_EXPIRES_MS) {
    return { kind: "creating" };
  }
  const lastError = record?.status === "failed" ? record.error : null;
  const built = buildBillPayload(i);
  if (!built.ok) return { kind: "blocked", problems: built.problems, lastError };
  const since = i.setting.since ? Date.parse(i.setting.since) : null;
  const beforeSince = since !== null && Date.parse(wo.completedAt) < since;
  return { kind: "ready", payload: built.payload, total: built.total, lastError, beforeSince };
}

/**
 * Automatic creation (after the shop completes, or after CDS enters the last TBD shop rate):
 * only for an order that never had an attempt and was completed after bills were turned on.
 * After a failure CDS retries by hand.
 */
export function shouldAutoCreate(state: BillState, record: BillRecord | null): boolean {
  return state.kind === "ready" && !state.beforeSince && record === null;
}

// ---------------------------------------------------------------- vendor match

/** Vendor entity (only the fields used): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor */
export type QboVendor = { Id: string; DisplayName: string; CompanyName?: string; Active?: boolean };

const SUFFIX = /\b(llc|l\s*l\s*c|inc|incorporated|corp|corporation|co|company|ltd|limited)\b\.?/g;

function vendorKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, "");
}

/**
 * The QuickBooks vendor suggested for a shop: an active vendor whose display or company name
 * is the shop name (ignoring case, punctuation and LLC / Inc), else one that contains it or is
 * contained in it. Null when nothing matches or two vendors match equally well: CDS picks.
 */
export function suggestVendor(shopName: string, vendors: QboVendor[]): QboVendor | null {
  const key = vendorKey(shopName);
  if (key.length < 3) return null;
  const active = vendors.filter((v) => v.Active !== false && v.Id?.trim());
  const keys = (v: QboVendor) => [vendorKey(v.DisplayName), vendorKey(v.CompanyName)].filter((k) => k.length >= 3);
  const unique = (hits: QboVendor[]) => (new Set(hits.map((v) => v.Id)).size === 1 ? hits[0] : null);
  const exact = active.filter((v) => keys(v).includes(key));
  if (exact.length) return unique(exact);
  const partial = active.filter((v) => keys(v).some((k) => k.includes(key) || key.includes(k)));
  return partial.length ? unique(partial) : null;
}
