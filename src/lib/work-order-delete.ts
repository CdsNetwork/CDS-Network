/**
 * Deleting a work order (CDS staff with profiles.can_delete_work_orders, which is Sarah only). The database removes the order and everything on it in
 * one transaction (public.cds_delete_work_order); QuickBooks is never touched, so an invoice
 * stays there and CDS voids it in QuickBooks.
 */
import type { ActionMessage } from "@/components/cds-wo/action-message";
import { woLabel } from "@/lib/format";

/** What a CDS login without the delete permission is told (the database says the same). */
export const DELETE_NOT_ALLOWED = "Only Sarah can delete work orders. Ask her to delete this one.";

export type QbInvoiceRef = { id: string; number: string | null } | null;

function invoiceName(invoice: { id: string; number: string | null }): string {
  return invoice.number ? invoice.number : `id ${invoice.id}`;
}

/** The browser confirmation before deleting: names the order and any QuickBooks invoice. */
export function deleteConfirmText({ woNumber, qbInvoice }: { woNumber: number; qbInvoice: QbInvoiceRef }): string {
  const parts = [
    `Delete ${woLabel(woNumber)}? Its lines, shipments, labels, notes, files and history are deleted too. This cannot be undone.`,
  ];
  if (qbInvoice) {
    parts.push(
      `QuickBooks invoice ${invoiceName(qbInvoice)} stays in QuickBooks: the portal does not change it, so void it in QuickBooks.`,
    );
  }
  return parts.join("\n\n");
}

const QB_RE = /^[A-Za-z0-9-]{1,30}$/;

/** The work order list URL after a delete, carrying what the list message shows. */
export function deletedHref(woNumber: number, qbInvoiceNumber: string | null): string {
  const sp = new URLSearchParams({ deleted: String(woNumber) });
  if (qbInvoiceNumber && QB_RE.test(qbInvoiceNumber)) sp.set("qb", qbInvoiceNumber);
  return `/cds?${sp.toString()}`;
}

type Params = Record<string, string | string[] | undefined>;

/** The message the work order list shows after a delete, or null. */
export function deletedMessage(sp: Params): ActionMessage | null {
  const deleted = sp.deleted;
  if (typeof deleted !== "string" || !/^\d{1,12}$/.test(deleted)) return null;
  const qb = typeof sp.qb === "string" && QB_RE.test(sp.qb) ? sp.qb : null;
  const text = `${woLabel(deleted)} was deleted.${qb ? ` QuickBooks invoice ${qb} is still in QuickBooks: void it there.` : ""}`;
  return { kind: "ok", text };
}

/**
 * Stored objects to remove with the order: the paths its rows recorded plus what is left in
 * its folder ('<work_order_id>/...'), and never anything outside that folder.
 */
export function storagePathsToRemove(workOrderId: string, recorded: (string | null)[], listed: string[]): string[] {
  const prefix = `${workOrderId.toLowerCase()}/`;
  const ok = (p: string | null): p is string => typeof p === "string" && p.toLowerCase().startsWith(prefix) && !p.includes("..");
  return [...new Set([...recorded, ...listed].filter(ok))];
}
