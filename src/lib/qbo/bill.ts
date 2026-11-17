import { money } from "@/lib/format";
import { deductionLabel, shopPayable, type ShopDeduction } from "@/lib/shop-deductions";
import type { CogsDivision } from "./cogs-division";
import type { BillFieldDefs, QboCustomField } from "./custom-fields";
import { cents, linkedItem, unlinkedItemMessage, type ItemMappings } from "./invoice";

/**
 * The shop's bill in CDS Inc's QuickBooks (M3). Pure: no database, no network.
 *
 * Bill fields: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill
 *   * VendorRef: the shop's QuickBooks vendor (qbo_affiliate_vendor, linked by CDS on Admin >
 *     Shop bills).
 *   * DocNumber: the shop's invoice number (work_orders.affiliate_invoice_ref, required when the
 *     shop completes the job). QuickBooks allows 21 characters: a longer number is cut there
 *     and kept whole in the memo. Without one: "WO-<number>", said in the memo.
 *   * TxnDate: the California date the shop completed the job.
 *   * Line: CDS bills shops by item (CDS, 2026-11-16): each work order line with a shop amount
 *     is an ItemBasedExpenseLineDetail with the QuickBooks item the customer's invoice uses for
 *     that line (qbo_item_map, ./invoice linkedItem), Qty and UnitPrice = the shop rate, so
 *     QuickBooks books it to that item's own expense account. The shipping deductions have no
 *     item: they go to the one account CDS chose for them (app_settings qbo_bill_line), as
 *     negative lines. The bill total is exactly what the shop sees in the portal
 *     (shopPayable). Lines of $0 are left off. Every line carries the shop's Class
 *     (qbo_affiliate_class).
 *   * DepartmentRef: the customer's COGS division (qbo_customer_cogs_division, ./cogs-division),
 *     found in QuickBooks on the customer's first bill (./bill-run); without one, none.
 *   * CustomField: "Fleet Number" (the work order's unit number) and "P.O. Number" (its PO),
 *     CDS's bill custom fields, added when sending (withBillCustomFields, ./bill-run) once
 *     their DefinitionIds are learned from recent bills. A value whose field is not found
 *     stays in the memo (PrivateNote) instead; it never stops the bill.
 *   * SalesTermRef: the terms, when they are part of that setting; else the QuickBooks term
 *     named Net 30 (all CDS vendors are Net 30, CDS 2026-11-16), added when sending
 *     (defaultBillTerm, ./bill-run); without such a term, the vendor's own.
 * A line whose item is not linked to a QuickBooks item stops the bill (the same message as the
 * invoice); an item without an expense account in QuickBooks is checked right before sending
 * (itemsWithoutExpenseAccount, ./bill-run).
 */

/** app_settings key of the shop bill setting. Unset: bills are off. */
export const BILL_SETTING_KEY = "qbo_bill_line";

/** The one QuickBooks account (or, as a fallback, item) the shipping deductions go to. */
export type BillTarget = { kind: "account" | "item"; id: string; name: string };

export type BillLineSetting = {
  /** Where the shipping deductions go. Null: orders with a deduction wait until CDS chooses. */
  deduction: BillTarget | null;
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
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseTarget(v: unknown): BillTarget | null {
  if (!isObject(v)) return null;
  const kind = v.kind;
  const id = str(v.id);
  const name = str(v.name);
  return (kind === "account" || kind === "item") && QBO_ID.test(id) && name ? { kind, id, name } : null;
}

/**
 * The stored setting, or null when bills are not turned on (no row, or nothing valid in it).
 * Stored: { mode: "item", since, deduction?: { kind, id, name }, terms_id?, terms_name? }.
 * The earlier shape { kind, id, name, since?, terms_id? } (one account or item for every line)
 * is read as the deduction account.
 */
export function parseBillSetting(value: unknown): BillLineSetting | null {
  if (!isObject(value)) return null;
  const sinceRaw = str(value.since);
  const since = sinceRaw && Number.isFinite(Date.parse(sinceRaw)) ? sinceRaw : null;
  const legacy = parseTarget(value);
  const deduction = parseTarget(value.deduction) ?? legacy;
  if (!since && !legacy && value.mode !== "item") return null;
  const termsId = str(value.terms_id);
  return {
    deduction,
    termsId: QBO_ID.test(termsId) ? termsId : null,
    termsName: QBO_ID.test(termsId) ? str(value.terms_name) || null : null,
    since,
  };
}

/** The stored form of a setting (app_settings.value). */
export function billSettingValue(s: BillLineSetting): Record<string, unknown> {
  return {
    mode: "item",
    ...(s.deduction ? { deduction: { kind: s.deduction.kind, id: s.deduction.id, name: s.deduction.name } } : {}),
    ...(s.termsId ? { terms_id: s.termsId, terms_name: s.termsName ?? "" } : {}),
    ...(s.since ? { since: s.since } : {}),
  };
}

export type BillWorkOrder = {
  id: string;
  woNumber: number;
  status: string;
  completedAt: string | null;
  customerId: string;
  /** work_orders.affiliate_invoice_ref: the shop's invoice or reference number. */
  shopInvoiceRef: string | null;
  customerName: string;
  poNumber: string | null;
  unitNumber: string | null;
  shopName: string;
  shopInHouse: boolean;
};

export type BillLine = {
  catalogItemId: string;
  sku: string;
  name: string;
  description: string | null;
  qty: number;
  shopUnitRate: number | null;
};

export type VendorLink = { qboVendorId: string; qboVendorName: string };

export type BillInputs = {
  workOrder: BillWorkOrder;
  lines: BillLine[];
  deductions: ShopDeduction[];
  vendor: VendorLink | null;
  setting: BillLineSetting | null;
  /** qbo_affiliate_class.qbo_class_id of the shop. */
  classId: string | null;
  /** qbo_customer_cogs_division of the customer: the bill's Division. Null: looked up when sending. */
  division: CogsDivision | null;
  /** qbo_customer_division.qbo_department_name (the invoice's INCOME division), to find the COGS one. */
  incomeDivisionName: string | null;
  /** The QuickBooks items of the order's catalog items, as the customer's invoice uses them. */
  itemMap: ItemMappings;
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
  /** The bill's custom fields (Fleet Number, P.O. Number), when found in QuickBooks. */
  CustomField?: QboCustomField[];
  /** The customer's COGS division. */
  DepartmentRef?: Ref;
  SalesTermRef?: Ref;
  Line: QboBillLine[];
};

export type BillBuild = { ok: true; payload: QboBillPayload; total: number } | { ok: false; problems: string[] };

/** What CDS is told when an order has a shipping deduction and no account is chosen for it. */
export const DEDUCTION_ACCOUNT_MISSING = "Choose the account for shipping deductions on Admin > Shop bills.";

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

/**
 * The bill memo: "Portal WO-<n>" first (./bill-run finds the portal's own bills by it), the
 * shop invoice, the customer, then the PO and the unit unless they are in custom fields.
 */
export function billMemo(wo: BillWorkOrder, inFields: { po?: boolean; unit?: boolean } = {}): string {
  const { note } = docNumber(wo);
  const po = inFields.po ? null : wo.poNumber?.trim();
  const unit = inFields.unit ? null : wo.unitNumber?.trim();
  return clip([`Portal WO-${wo.woNumber}`, note, wo.customerName, po && `PO ${po}`, unit && `Unit ${unit}`].filter(Boolean).join(" | "), 4000);
}

/** Bill custom field names the bill's unit and PO go to (CDS's QuickBooks; matched loosely, ./custom-fields). */
export const BILL_FLEET_FIELD = "Fleet Number";
export const BILL_PO_FIELD = "P.O. Number";

/** True when the order has a PO or a unit number for the bill's custom fields. */
export function hasBillFieldValues(wo: BillWorkOrder): boolean {
  return !!(wo.poNumber?.trim() || wo.unitNumber?.trim());
}

/**
 * The bill with its Fleet Number and P.O. Number custom fields filled where QuickBooks has
 * the field (defs learned from recent bills), the memo without the values now in fields,
 * and a note for each value kept in the memo because its field was not found.
 */
export function withBillCustomFields(
  payload: QboBillPayload,
  wo: BillWorkOrder,
  defs: BillFieldDefs,
): { payload: QboBillPayload; notes: string[] } {
  const fields: QboCustomField[] = [];
  const notes: string[] = [];
  const add = (def: BillFieldDefs["fleet"], label: string, value: string | null | undefined): boolean => {
    const v = value?.trim();
    if (!v) return false;
    if (!def) {
      notes.push(`QuickBooks has no bill custom field named "${label}", so ${label} is in the bill memo.`);
      return false;
    }
    fields.push({ DefinitionId: def.id, Name: def.name, Type: "StringType", StringValue: clip(v, 4000) });
    return true;
  };
  const unit = add(defs.fleet, BILL_FLEET_FIELD, wo.unitNumber);
  const po = add(defs.po, BILL_PO_FIELD, wo.poNumber);
  if (!fields.length) return { payload, notes };
  return { payload: { ...payload, CustomField: fields, PrivateNote: billMemo(wo, { po, unit }) }, notes };
}

export function buildBillPayload(i: BillInputs): BillBuild {
  const { workOrder: wo, setting } = i;
  const problems: string[] = [];
  if (!setting) problems.push("QuickBooks bills are not set up yet.");
  if (!i.vendor?.qboVendorId?.trim()) {
    problems.push(`${wo.shopName} is not linked to a QuickBooks vendor. Link it on Admin > Shop bills.`);
  }
  const unlinked = new Set<string>();
  for (const l of i.lines) {
    if (l.shopUnitRate === null || !Number.isFinite(Number(l.shopUnitRate))) {
      problems.push(`The shop rate for ${l.sku} ${l.name} is not set yet (TBD). Enter it on the line.`);
    } else if (cents(l.qty * Number(l.shopUnitRate)) !== 0 && !linkedItem(i.itemMap, l.catalogItemId) && !unlinked.has(l.catalogItemId)) {
      // Never guessed: the line goes on the item the customer's invoice uses, or the bill waits.
      unlinked.add(l.catalogItemId);
      problems.push(unlinkedItemMessage(i.itemMap, l, wo.customerName));
    }
  }
  if (setting && !setting.deduction && i.deductions.some((d) => cents(d.amount) !== 0)) problems.push(DEDUCTION_ACCOUNT_MISSING);
  if (!i.lines.length) problems.push("The work order has no lines to bill.");
  if (problems.length || !setting || !i.vendor) return { ok: false, problems };

  const total = billTotal(i);
  if (!(total > 0)) {
    return { ok: false, problems: [`The shop total is ${money(total)}, so there is nothing to bill. Enter a credit in QuickBooks if one is owed.`] };
  }

  const classRef = i.classId?.trim() ? { ClassRef: { value: i.classId.trim() } } : {};
  const itemLine = (item: Ref, amount: number, description: string, qty: number, unitPrice: number): QboBillLine => ({
    DetailType: "ItemBasedExpenseLineDetail",
    Amount: amount,
    Description: clip(description, 4000),
    ItemBasedExpenseLineDetail: { ItemRef: item, Qty: qty, UnitPrice: unitPrice, ...classRef, BillableStatus: "NotBillable" },
  });

  const lines: QboBillLine[] = [];
  for (const l of i.lines) {
    const rate = Number(l.shopUnitRate);
    const amount = cents(l.qty * rate);
    if (amount === 0) continue;
    const item = linkedItem(i.itemMap, l.catalogItemId)!;
    const text = [`${l.sku} ${l.name}`.trim(), l.description?.trim()].filter(Boolean).join(" - ");
    lines.push(itemLine({ value: item.qboItemId.trim(), name: item.qboItemName }, amount, `${text} (${l.qty} x ${money(rate)})`, l.qty, rate));
  }
  const target = setting.deduction;
  for (const d of i.deductions) {
    const amount = cents(d.amount);
    if (!amount || !target) continue;
    lines.push(
      target.kind === "account"
        ? {
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: amount,
            Description: clip(deductionLabel(d), 4000),
            AccountBasedExpenseLineDetail: { AccountRef: { value: target.id, name: target.name }, ...classRef, BillableStatus: "NotBillable" },
          }
        : itemLine({ value: target.id, name: target.name }, amount, deductionLabel(d), d.filters, d.unit_amount),
    );
  }

  const { doc } = docNumber(wo);
  return {
    ok: true,
    total,
    payload: {
      VendorRef: { value: i.vendor.qboVendorId.trim(), name: i.vendor.qboVendorName },
      TxnDate: billTxnDate(wo.completedAt ?? new Date()),
      DocNumber: doc,
      PrivateNote: billMemo(wo),
      ...(i.division ? { DepartmentRef: { value: i.division.id, name: i.division.name } } : {}),
      ...(setting.termsId ? { SalesTermRef: { value: setting.termsId, ...(setting.termsName ? { name: setting.termsName } : {}) } } : {}),
      Line: lines,
    },
  };
}

/** Term entity (only the fields used): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/term */
export type QboBillTerm = { Id: string; Name: string; Active?: boolean };

/**
 * The bill terms when CDS chose none: the one active QuickBooks term named Net 30 (ignoring
 * case and spaces). Null when there is none or two: the vendor's own terms apply.
 */
export function defaultBillTerm(terms: QboBillTerm[]): { value: string; name: string } | null {
  const hits = terms.filter((t) => t.Active !== false && t.Id?.trim() && (t.Name ?? "").toLowerCase().replace(/\s+/g, "") === "net30");
  return hits.length === 1 ? { value: hits[0].Id.trim(), name: hits[0].Name } : null;
}

/** Item entity (only the fields used): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item */
export type QboBillItem = { Id: string; Name?: string; ExpenseAccountRef?: { value?: string; name?: string } };

/** The QuickBooks item ids on a bill's item lines. */
export function billItemIds(payload: QboBillPayload): string[] {
  const ids = payload.Line.flatMap((l) => (l.DetailType === "ItemBasedExpenseLineDetail" ? [l.ItemBasedExpenseLineDetail.ItemRef.value] : []));
  return [...new Set(ids)];
}

/**
 * The bill's items that QuickBooks has without an expense account (customer-only items, such
 * as a fee CDS never pays a shop for): QuickBooks would refuse the bill, so CDS is told which
 * item to fix. An item QuickBooks did not return is left to QuickBooks's own answer.
 */
export function itemsWithoutExpenseAccount(payload: QboBillPayload, items: QboBillItem[]): string[] {
  const byId = new Map(items.map((it) => [it.Id, it]));
  const problems = new Map<string, string>();
  for (const l of payload.Line) {
    if (l.DetailType !== "ItemBasedExpenseLineDetail") continue;
    const ref = l.ItemBasedExpenseLineDetail.ItemRef;
    const item = byId.get(ref.value);
    if (!item || item.ExpenseAccountRef?.value?.trim() || problems.has(ref.value)) continue;
    const portal = l.Description.replace(/ \([^()]*\)$/, "").split(" - ")[0];
    problems.set(
      ref.value,
      `QuickBooks item ${item.Name ?? ref.name ?? ref.value} (${portal}) has no expense account, so it cannot go on a shop bill. Add its expense account in QuickBooks (Purchasing information), then Retry.`,
    );
  }
  return [...problems.values()];
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
  /** Completed, but CDS has not turned shop bills on yet. */
  | { kind: "not_set_up" }
  | { kind: "creating" }
  | {
      kind: "created";
      billId: string;
      number: string | null;
      total: number | null;
      at: string | null;
      changedTotal: number | null;
      /** The customer's remembered COGS division; null: no division matched, so the bill has none. */
      division: CogsDivision | null;
    }
  /** Completed, but something must be fixed first (vendor link, a TBD shop rate, an item link, the deduction account). */
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
      division: i.division,
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

/** The words of a name: lower case, punctuation and LLC / Inc / Co dropped, "&" read as "and". */
function vendorWords(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(SUFFIX, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const startsWith = (words: string[], lead: string[]) => lead.length <= words.length && lead.every((w, i) => words[i] === w);

/**
 * The QuickBooks vendor suggested for a shop: an active vendor whose display or company name
 * is the shop name (ignoring case, punctuation and LLC / Inc), else one whose name starts with
 * the shop name's words when the shop name has at least two words ("Kings Truck" for "Kings
 * Truck Center Inc."). A single place name inside a vendor name ("Connecticut" in "Connecticut
 * Department of Revenue") is never enough. Null when nothing matches or two vendors match
 * equally well: CDS picks.
 */
export function suggestVendor(shopName: string, vendors: QboVendor[]): QboVendor | null {
  const shop = vendorWords(shopName);
  if (shop.join("").length < 3) return null;
  const active = vendors.filter((v) => v.Active !== false && v.Id?.trim());
  const names = (v: QboVendor) => [vendorWords(v.DisplayName), vendorWords(v.CompanyName)].filter((w) => w.join("").length >= 3);
  const unique = (hits: QboVendor[]) => (new Set(hits.map((v) => v.Id)).size === 1 ? hits[0] : null);
  // Spaces ignored, as before: "Enviro Motive" is "Enviromotive".
  const same = (a: string[], b: string[]) => a.join("") === b.join("");
  const exact = active.filter((v) => names(v).some((n) => same(n, shop)));
  if (exact.length) return unique(exact);
  if (shop.length < 2) return null;
  const leading = active.filter((v) => names(v).some((n) => startsWith(n, shop)));
  return leading.length ? unique(leading) : null;
}
