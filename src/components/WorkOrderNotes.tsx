import type { ReactNode } from "react";
import { dateTime } from "@/lib/format";
import type { NoteView } from "@/lib/notes";

/**
 * Notes shared by CDS and the assigned shop, oldest first: author, Pacific date and time,
 * and the text as typed (plain text, line breaks kept). Used on the CDS work order page
 * and the shop job view; `actions` adds controls next to a note (CDS: Delete).
 */
export function NotesList({ notes, actions }: { notes: NoteView[]; actions?: (note: NoteView) => ReactNode }) {
  if (notes.length === 0) return <p className="small">No notes yet.</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {notes.map((n) => (
        <div key={n.id} className="routebox">
          <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
            <span className="small">
              <b>{n.author_name}</b> · {dateTime(n.created_at)}
            </span>
            {actions?.(n)}
          </div>
          <div style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.body}</div>
        </div>
      ))}
    </div>
  );
}
