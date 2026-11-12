/**
 * The customer invoice in QuickBooks (invoice any time, CDS 2026-11-12).
 *
 * CDS may create it at any status except cancelled and already invoiced. An order whose work
 * is done moves to Invoiced right away; any other order keeps its status, and the database
 * moves it to Invoiced when the shop completes it (public.shop_complete_work_order). From the
 * moment the invoice exists, the customer lines, tax, customer and location are locked as on
 * an invoiced order (private.wo_invoiced in 20261112040000_invoice_any_time.sql).
 */

/** Statuses at which the work is done: creating the invoice moves the order to Invoiced. */
export const MOVES_TO_INVOICED_STATUSES = ["completed", "delivered", "ready_to_invoice"];

/** True when creating the invoice moves the order to Invoiced right away. */
export function movesToInvoiced(status: string): boolean {
  return MOVES_TO_INVOICED_STATUSES.includes(status);
}

/** True when the order is invoiced, or has a QuickBooks invoice while the shop is still working. */
export function invoiceLocked(status: string, qbInvoiceId: string | null | undefined): boolean {
  return status === "invoiced" || Boolean(qbInvoiceId);
}

/** Why CDS cannot create the invoice now, or null when it can. */
export function invoiceBlockReason(status: string, qbInvoiceId: string | null | undefined): string | null {
  if (qbInvoiceId) return `This work order already has QuickBooks invoice ${qbInvoiceId}.`;
  if (status === "invoiced") return "This work order is already invoiced.";
  if (status === "cancelled") return "A cancelled work order cannot be invoiced.";
  return null;
}

/** The message after the invoice is created or recorded. */
export function invoicedOutcome(status: string): string {
  return movesToInvoiced(status)
    ? "The work order is now Invoiced."
    : "The order keeps its status and moves to Invoiced when the shop completes the job.";
}

/** One embedded row from Supabase: an object, a one-item array or null. */
type MaybeOne<T> = T | T[] | null | undefined;

/** The QuickBooks invoice id from a work_orders row read with work_order_internal(qb_invoice_id). */
export function qbInvoiceIdOf(internal: MaybeOne<{ qb_invoice_id: string | null }>): string | null {
  const row = Array.isArray(internal) ? internal[0] : internal;
  return row?.qb_invoice_id ?? null;
}
