/**
 * "Request invoice correction" (Sarah, CDS, 2026-11-17). On a completed job the shop asks CDS
 * to correct the invoice with a short reason. It is stored as an ordinary shop note (shared
 * with CDS) that starts with INVOICE_CORRECTION_PREFIX, so it raises "New from shop" like any
 * shop note (private.shop_note_activity) and the CDS dashboard can mark the row. Safe on
 * server and client.
 */

export const INVOICE_CORRECTION_PREFIX = "Invoice correction requested: ";

/** A short reason: at most this many characters. */
export const CORRECTION_REASON_MAX = 500;

/** Statuses after the shop completed the job, in which it can ask for a correction. */
const CORRECTION_STATUSES = ["completed", "delivered", "ready_to_invoice", "invoiced"];

export function canRequestCorrection(status: string): boolean {
  return CORRECTION_STATUSES.includes(status);
}

/** The note body for a reason, or why the reason is not accepted. */
export function correctionNote(reason: FormDataEntryValue | null | undefined): { body: string } | { error: string } {
  const text = (typeof reason === "string" ? reason : "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { error: "Tell CDS what needs correcting." };
  if ([...text].length > CORRECTION_REASON_MAX) return { error: `Keep the reason to ${CORRECTION_REASON_MAX} characters or fewer.` };
  return { body: `${INVOICE_CORRECTION_PREFIX}${text}` };
}

type Note = { body: string; created_at: string; author_kind: string | null };

/**
 * The "Correction requested" mark of the CDS dashboard: a note by a shop login asking for a
 * correction, written after CDS last opened the order, or CDS never opened it.
 */
export function correctionRequested(notes: Note[] | null | undefined, cdsViewedAt: string | null | undefined): boolean {
  const seen = cdsViewedAt ? Date.parse(cdsViewedAt) : null;
  return (notes ?? []).some(
    (n) => n.author_kind === "shop" && n.body.startsWith(INVOICE_CORRECTION_PREFIX) && (seen === null || Date.parse(n.created_at) > seen),
  );
}
