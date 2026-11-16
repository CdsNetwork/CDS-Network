/**
 * Editing from the CDS work order list (Sarah, CDS, 2026-11-13; milestone M3): status,
 * internal status and notes without opening the order, with the same rules as the work order
 * page. The database still checks every move (public.cds_set_status).
 */
import { internalNotesHistory, type NoteView } from "@/lib/notes";

export type ListStatusTarget = "delivered" | "ready_to_invoice" | "pending_review" | "cancelled";

export type StatusMove = { status: ListStatusTarget; label: string; confirm?: string };

const CANCEL_CONFIRM = "Cancel this work order? The shop will see that it was cancelled.";
const REVIEW_CONFIRM = "Take this order back from the shop and return it to review?";

/**
 * The status changes the work order page offers for an order, in the page's order: Mark
 * Delivered (completed), Ready to Invoice (completed or delivered), Send back to review
 * (awaiting acceptance) and Cancel (not cancelled and not locked by its customer invoice,
 * see @/lib/invoice-lock). Dispatching and invoicing need the order page.
 */
export function listStatusMoves(status: string, invoiceLocked: boolean): StatusMove[] {
  const out: StatusMove[] = [];
  if (status === "completed") out.push({ status: "delivered", label: "Delivered" });
  if (status === "completed" || status === "delivered") out.push({ status: "ready_to_invoice", label: "Ready to Invoice" });
  if (status === "awaiting_acceptance") out.push({ status: "pending_review", label: "Back to review", confirm: REVIEW_CONFIRM });
  if (!invoiceLocked && status !== "cancelled" && status !== "invoiced") {
    out.push({ status: "cancelled", label: "Cancel order", confirm: CANCEL_CONFIRM });
  }
  return out;
}

/** A note row as read for the popover (select *): edited_at exists once internal notes can be edited. */
export type NoteRow = NoteView & { author_id: string | null; edited_at?: string | null };

export type PopoverNote = NoteView & { edited_at: string | null; editable: boolean };

export type PopoverNotes = { internal: PopoverNote[]; shared: PopoverNote[] };

function view(n: NoteView & { edited_at?: string | null }, editable: boolean): PopoverNote {
  return { id: n.id, author_name: n.author_name, created_at: n.created_at, body: n.body, edited_at: n.edited_at ?? null, editable };
}

/**
 * The notes popover of one order, oldest first like the order page: the CDS-only internal
 * notes (starting with the text written when the order was created) and the notes the shop
 * sees. CDS edits only its own internal notes; a note the shop sees is never edited.
 */
export function popoverNotes(input: {
  createdText: string | null | undefined;
  orderCreatedAt: string;
  internal: NoteRow[];
  shared: NoteRow[];
  me: string;
}): PopoverNotes {
  const mine = new Map(input.internal.map((n) => [n.id, n.author_id !== null && n.author_id === input.me]));
  const edited = new Map(input.internal.map((n) => [n.id, n.edited_at ?? null]));
  const internal = internalNotesHistory(input.createdText, input.orderCreatedAt, input.internal).map((n) =>
    view({ ...n, edited_at: edited.get(n.id) ?? null }, mine.get(n.id) ?? false),
  );
  return { internal, shared: input.shared.map((n) => view(n, false)) };
}
