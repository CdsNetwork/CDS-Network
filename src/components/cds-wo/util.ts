/** Helpers shared by the CDS work order screens. Safe on server and client. */

/** PostgREST returns a to-one embed as an object, but older relations may come back as arrays. */
export function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export const REQUEST_TYPE_LABEL: Record<string, string> = {
  service: "Service / Cleaning",
  parts_only: "Parts Only",
};

export const PRICE_SOURCE_LABEL: Record<string, string> = {
  fleet: "Fleet price",
  customer_override: "Customer override",
  manual: "Manual",
};

export const TAX_CLASS_LABEL: Record<string, string> = {
  parts: "Parts",
  labor: "Labor",
  shipping: "Shipping",
  exempt: "Exempt",
};

export const LABEL_STATUS_LABEL: Record<string, string> = {
  needed: "Needed",
  ready: "Ready",
  sent: "Sent",
  printed: "Printed",
  voided: "Voided",
  error: "Error",
};

export const CUSTOMER_APPROVAL_LABEL: Record<string, string> = {
  not_requested: "Customer approval not requested",
  requested: "Customer approval requested",
  approved: "Customer approved",
  declined: "Customer declined",
};

/** Statuses after which the shop has finished: its lines are fixed for the shop. */
export const LINES_LOCKED_STATUSES = ["completed", "delivered", "ready_to_invoice", "invoiced", "cancelled"];

/**
 * Whether CDS can no longer add or remove the order's lines. After the shop completed the job
 * CDS still corrects its lines (kits for the loose parts a shop billed, Sarah, CDS,
 * 2026-11-23) until the shop's bill is in QuickBooks; never once the order is invoiced (or has
 * its QuickBooks invoice) or is cancelled.
 */
export function linesLocked(status: string, invoiceLocked: boolean, shopBilled: boolean): boolean {
  if (status === "cancelled" || status === "invoiced" || invoiceLocked) return true;
  return LINES_LOCKED_STATUSES.includes(status) && shopBilled;
}

/** The completed orders whose shop bill waits for CDS (dashboard tag and filter, CSV column, work order page). */
export const SHOP_BILL_PENDING_LABEL = "AFF Bill Pnd Approval";

/** Statuses in which CDS may still edit the order fields and dispatch. */
export const REVIEW_STATUSES = ["pending_review", "rejected_by_affiliate"];

/**
 * Whether the work order page offers the PO-only edit (Sarah, CDS, 2026-11-17): after
 * dispatch, at any status but cancelled, also once invoiced. In review the Edit order box has
 * the PO with the other fields.
 */
export function canEditPoOnly(status: string): boolean {
  return !REVIEW_STATUSES.includes(status) && status !== "cancelled";
}

/**
 * Whether the work order page offers the request-type-only change (Sarah, CDS, 2026-11-18: a
 * filter failed and a part is sold instead, so the shop must not be asked for measurements):
 * while the shop has the job, before it is completed. In review the Edit order box has the
 * request type with the other fields.
 */
export function canEditRequestTypeOnly(status: string): boolean {
  return !REVIEW_STATUSES.includes(status) && !LINES_LOCKED_STATUSES.includes(status);
}

/**
 * Whether the work order page offers the unit-only and location-only edits (Sarah, CDS,
 * 2026-11-24: a missing location or a wrong unit needed a decline and a new dispatch): after
 * dispatch, at any status but cancelled, until the customer invoice exists (Invoiced, or a
 * QuickBooks invoice on the order). Unlike the PO both stay fixed then: the unit is in the
 * invoice memo and the location gives its sub-customer, ship-to address and tax, and the portal
 * never changes QuickBooks. In review the Edit order box has them with the other fields.
 */
export function canEditUnitOrLocationOnly(status: string, qbInvoiceId: string | null): boolean {
  return !REVIEW_STATUSES.includes(status) && status !== "cancelled" && status !== "invoiced" && !qbInvoiceId;
}

/**
 * Whether the work order page offers "Edit fulfillment" (shipping or shop pickup) after
 * dispatch (Sarah, CDS, 2026-11-24): as for the unit and location (canEditUnitOrLocationOnly:
 * the method gives the customer shipping charge on the invoice), and also not once the shop's
 * bill is in QuickBooks or being created (shopBillLocked), as the method decides the shop's
 * shipping deduction on that bill. public.cds_set_fulfillment refuses the same.
 */
export function canEditFulfillmentOnly(status: string, qbInvoiceId: string | null, shopBillLocked: boolean): boolean {
  return canEditUnitOrLocationOnly(status, qbInvoiceId) && !shopBillLocked;
}

/** The methods CDS chooses between after dispatch. */
export const FULFILLMENT_AFTER_DISPATCH = ["shipping", "pickup"] as const;

/** Shown with the location edit when the order has shipping labels (they are never changed). */
export const LABELS_KEEP_OLD_ADDRESS_NOTE = "Shipping labels already made keep the old address.";

/** Shown with the PO edit when the order already has its QuickBooks invoice (the portal never changes it). */
export const PO_IN_QUICKBOOKS_NOTE = "This invoice is already in QuickBooks. Change the PO there too.";

/**
 * Shop preselected in the dispatch Shop box: the shop the order is with, else the location's
 * default shop. After a decline the declining shop is never preselected, so the location
 * default is offered unless it is that same shop, in which case nothing is.
 */
export function dispatchShopDefault({
  status,
  affiliateId,
  locationDefault,
}: {
  status: string;
  affiliateId: string | null;
  locationDefault: string | null;
}): string {
  if (status === "rejected_by_affiliate") {
    return locationDefault && locationDefault !== affiliateId ? locationDefault : "";
  }
  return affiliateId ?? locationDefault ?? "";
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
