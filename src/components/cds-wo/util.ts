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

/**
 * Label statuses of a shipment leg that has no label: never made, or voided. Any other status
 * means a label exists (made in the portal or by hand) or one was being made, so the leg stays.
 */
export const REMOVABLE_LABEL_STATUSES = ["needed", "voided"];

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
