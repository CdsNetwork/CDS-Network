/**
 * "Question Pending" on CDS work orders (20261111070000_question_pending.sql). Safe on server
 * and client.
 *
 * CDS's Google Sheet turned a row hot pink when Ryder had a question CDS had to take to the
 * shop and answer back. CDS switches the flag on and off on the work order page; the work
 * order list shows a pink badge on those rows and can show only them. It never changes the
 * order's status, and shops never see it.
 */
import { one } from "./util";

/** Query string parameter of the "Question Pending" list filter ("1" turns it on). */
export const QUESTION_PARAM = "question";

/** Longest question note CDS can save (the database allows the same). */
export const QUESTION_NOTE_MAX = 500;

export type QuestionRow = { question_pending: boolean | null; note?: string | null };

/** The embedded work_order_questions row, as an object or an array, when the flag is on. */
function pendingRow(row: QuestionRow | QuestionRow[] | null | undefined): QuestionRow | null {
  const r = one(row ?? null);
  return r?.question_pending ? r : null;
}

export function isQuestionPending(row: QuestionRow | QuestionRow[] | null | undefined): boolean {
  return pendingRow(row) !== null;
}

/** The badge's hover text: the question note when there is one. */
export function questionTitle(row: QuestionRow | QuestionRow[] | null | undefined): string | null {
  const r = pendingRow(row);
  if (!r) return null;
  const note = r.note?.trim();
  return note ? `Question: ${note}` : "A customer question is waiting on the shop or on CDS";
}

/** The note as saved: trimmed, empty becomes null; an error when it is too long. */
export function questionNote(raw: FormDataEntryValue | null): { note: string | null } | { error: string } {
  const note = typeof raw === "string" ? raw.trim() : "";
  if (note.length > QUESTION_NOTE_MAX) return { error: `Keep the question note under ${QUESTION_NOTE_MAX} characters.` };
  return { note: note || null };
}
