/**
 * An invoice QuickBooks created for a work order that the portal has not recorded on it yet
 * (the invoice was created, then marking the work order Invoiced failed).
 *
 * Every created invoice is written to integration_sync first (system 'quickbooks', entity
 * 'invoice', status 'ok', external_id = the QuickBooks invoice Id, error = createdNote(DocNumber)).
 * While the work order has no qb_invoice_id, the newest such row is the invoice to record: the
 * next "Create QuickBooks invoice" records it instead of sending a new one.
 */

export type InvoiceSyncRow = { status: string; external_id: string | null; error: string | null; at: string };

export type PendingQbInvoice = { id: string; number: string | null; at: string };

const NOTE = "QuickBooks invoice number ";

const SEP = " | ";

/**
 * The note kept on the 'ok' row (integration_sync has no other free text column): the
 * invoice number, then what the invoice was sent with (sub-customer, fields left out).
 */
export function createdNote(docNumber: string | null | undefined, notes: string[] = []): string | null {
  const parts = [docNumber ? `${NOTE}${docNumber}` : null, ...notes].filter((p): p is string => !!p);
  return parts.length ? parts.join(SEP) : null;
}

export function pendingQbInvoice(rows: InvoiceSyncRow[]): PendingQbInvoice | null {
  const created = rows
    .filter((r) => r.status === "ok" && r.external_id)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (!created) return null;
  const number = created.error?.startsWith(NOTE) ? created.error.slice(NOTE.length).split(SEP)[0].trim() || null : null;
  return { id: created.external_id!, number, at: created.at };
}
