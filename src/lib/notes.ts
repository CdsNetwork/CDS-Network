/** Work order notes shared by CDS and the assigned shop (public.work_order_notes). */

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
