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

/** Statuses after which the order lines are fixed. */
export const LINES_LOCKED_STATUSES = ["completed", "delivered", "ready_to_invoice", "invoiced", "cancelled"];

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
