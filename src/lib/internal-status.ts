/**
 * CDS-only internal status (Sarah, CDS dispatch, 2026-11-12): what CDS tracks outside the
 * portal (mostly in email), set by hand on the work order page and shown in the work order
 * list. It never changes the order's status and shops never see it
 * (work_order_internal.internal_status, 20261112030000_internal_status.sql).
 */

export const INTERNAL_STATUSES = ["eta_sent", "condemned", "invoice_ready", "invoice_sent", "no_action_needed", "closed"] as const;

export type InternalStatus = (typeof INTERNAL_STATUSES)[number];

export const INTERNAL_STATUS_LABEL: Record<InternalStatus, string> = {
  eta_sent: "ETA Sent",
  condemned: "Condemned",
  invoice_ready: "Invoice Ready",
  invoice_sent: "Invoice Sent",
  no_action_needed: "No Action Needed",
  closed: "Closed",
};

export function isInternalStatus(value: unknown): value is InternalStatus {
  return typeof value === "string" && (INTERNAL_STATUSES as readonly string[]).includes(value);
}

/** The label of a stored value, or null for blank (or a value this version does not know). */
export function internalStatusLabel(value: string | null | undefined): string | null {
  return isInternalStatus(value) ? INTERNAL_STATUS_LABEL[value] : null;
}

/** The select's value: blank clears it. */
export function parseInternalStatus(value: FormDataEntryValue | null): { value: InternalStatus | null } | { error: string } {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return { value: null };
  if (!isInternalStatus(s)) return { error: "Choose an internal status from the list." };
  return { value: s };
}
