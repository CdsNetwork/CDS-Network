/** Work order notes: shared by CDS and the assigned shop (public.work_order_notes) and CDS-only internal notes (public.work_order_internal_notes). */

export const NOTE_MAX_LENGTH = 2000;

export type NoteView = { id: string; author_name: string; created_at: string; body: string };

/**
 * The note text from a form, as the database stores it: line breaks as "\n" (browsers send
 * a textarea's line breaks as "\r\n"), spaces and blank lines trimmed at both ends, 1 to
 * 2000 characters (counted like Postgres char_length).
 */
export function noteBody(value: FormDataEntryValue | null): { body: string } | { error: string } {
  const body = (typeof value === "string" ? value : "").replace(/\r\n?/g, "\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  if (!body) return { error: "Write a note first." };
  const length = [...body].length;
  if (length > NOTE_MAX_LENGTH) {
    return { error: `The note is too long (${length} characters, max ${NOTE_MAX_LENGTH}).` };
  }
  return { body };
}

/** The id of the first entry of the internal notes history: the notes written with the order. */
export const ORDER_CREATED_NOTE_ID = "order-created";

/**
 * The CDS-only internal notes history of a work order, oldest first. The first entry is the
 * one-off work_order_internal.internal_notes text written when the order was created (by
 * hand or from the intake email), dated with the order, when it has any text; then the notes
 * from public.work_order_internal_notes in the order given.
 */
export function internalNotesHistory(
  createdText: string | null | undefined,
  orderCreatedAt: string,
  notes: NoteView[],
): NoteView[] {
  const body = (createdText ?? "").replace(/\r\n?/g, "\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  if (!body) return notes;
  return [{ id: ORDER_CREATED_NOTE_ID, author_name: "When the order was created", created_at: orderCreatedAt, body }, ...notes];
}
