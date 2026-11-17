import { createHash } from "node:crypto";

/**
 * A fingerprint of the customer invoice as the portal builds it (before the QuickBooks
 * lookups): the same details give the same value, any change in a line, amount, customer, PO or
 * text gives another. Kept on the invoice claim so the result QuickBooks returns can be checked
 * against the details it was asked with.
 */
export function invoiceSnapshot(invoice: { payload: unknown; itemText: unknown }): string {
  return createHash("sha256").update(stable({ payload: invoice.payload, itemText: invoice.itemText })).digest("hex");
}

/** JSON with object keys sorted, so the key order never changes the fingerprint. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> };

/**
 * The claim on an order's customer invoice (public.cds_claim_qbo_invoice,
 * 20261118030000_qbo_invoice_claims.sql), taken before QuickBooks is called:
 *   * "sending": this request holds the claim and sends with requestId; snapshot is the
 *     fingerprint of the details QuickBooks may already have (an earlier unconfirmed request),
 *     else the one passed in;
 *   * "created": QuickBooks created invoice qbInvoiceId for this order and it is not recorded
 *     yet; no claim is taken, the invoice is to be recorded.
 * ownerId is the order the claim is on (cds_finish_qbo_invoice is called with it): this order,
 * or for two linked work orders the first one (20261119080000_combined_invoice.sql).
 *
 * linkedId: the other work order the invoice was built for (one invoice for two linked work
 * orders), left out for an order on its own; the database refuses the claim when the links
 * say otherwise.
 */
export type InvoiceClaim =
  | { state: "sending"; claimId: string; requestId: string; snapshot: string | null; ownerId: string }
  | { state: "created"; qbInvoiceId: string; snapshot: string | null; ownerId: string };

export async function claimInvoice(
  db: Rpc,
  woId: string,
  snapshot: string | null,
  linkedId?: string,
): Promise<{ ok: true; claim: InvoiceClaim } | { ok: false; error: string }> {
  const { data, error } = await db.rpc("cds_claim_qbo_invoice", {
    p_work_order: woId,
    p_snapshot: snapshot,
    ...(linkedId ? { p_linked: linkedId } : {}),
  });
  if (error) {
    // Raised by the function: written for users.
    if (error.code === "P0001" || error.code === "P0002") return { ok: false, error: error.message };
    return { ok: false, error: "The invoice could not be started. Try again." };
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const snap = typeof d.snapshot === "string" ? d.snapshot : null;
  const ownerId = typeof d.work_order_id === "string" ? d.work_order_id : woId;
  if (d.state === "created" && typeof d.qb_invoice_id === "string") {
    return { ok: true, claim: { state: "created", qbInvoiceId: d.qb_invoice_id, snapshot: snap, ownerId } };
  }
  if (d.state === "sending" && typeof d.claim_id === "string" && typeof d.request_id === "string") {
    return { ok: true, claim: { state: "sending", claimId: d.claim_id, requestId: d.request_id, snapshot: snap, ownerId } };
  }
  return { ok: false, error: "The invoice could not be started. Try again." };
}

/**
 * Records how the attempt ended (public.cds_finish_qbo_invoice): "created" (with the invoice
 * id), "refused" (QuickBooks answered with a refusal: the next attempt uses a new request id),
 * "unconfirmed" (QuickBooks may have the request: the next attempt uses the same id) or
 * "not_sent" (QuickBooks was never called). Never throws: a claim left open expires after 5
 * minutes and is then treated as unconfirmed.
 */
export async function finishInvoice(
  db: Rpc,
  woId: string,
  claimId: string | null,
  outcome: "created" | "refused" | "unconfirmed" | "not_sent",
  qbInvoiceId: string | null = null,
): Promise<void> {
  try {
    const { error } = await db.rpc("cds_finish_qbo_invoice", { p_work_order: woId, p_claim: claimId, p_outcome: outcome, p_qb_invoice_id: qbInvoiceId });
    if (error) console.error(`QuickBooks invoice claim of ${woId} not finished as ${outcome}: ${error.message}`);
  } catch (e) {
    console.error(`QuickBooks invoice claim of ${woId} not finished as ${outcome}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Told to staff when the order's invoice details differ from the ones QuickBooks was asked with. */
export function changedSinceNote(invoiceName: string): string {
  return `The work order changed after QuickBooks was first asked for this invoice. Check invoice ${invoiceName} in QuickBooks against the order.`;
}
