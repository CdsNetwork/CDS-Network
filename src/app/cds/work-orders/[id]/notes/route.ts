import { NextResponse } from "next/server";
import { popoverNotes, type NoteRow } from "@/components/cds-wo/list-edits";
import { isUuid } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The notes of one work order for the notes popover of the CDS work order list, loaded only
 * when the popover opens: CDS-only internal notes and the notes the shop sees, oldest first.
 * CDS staff only (RLS limits both tables too).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await requireCds();
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  const supabase = await createClient();
  const [woRes, internalRes, sharedRes] = await Promise.all([
    supabase.from("work_orders").select("created_at, work_order_internal(internal_notes)").eq("id", id).maybeSingle(),
    // select *: edited_at exists only once 20261117020000_edit_internal_notes.sql is applied.
    supabase.from("work_order_internal_notes").select("*").eq("work_order_id", id).order("created_at"),
    supabase.from("work_order_notes").select("id, author_id, author_name, created_at, body").eq("work_order_id", id).order("created_at"),
  ]);
  if (woRes.error || internalRes.error || sharedRes.error) {
    return NextResponse.json({ error: "Notes could not be loaded. Try again." }, { status: 500 });
  }
  if (!woRes.data) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  const internalRow = woRes.data.work_order_internal as unknown as { internal_notes: string | null } | { internal_notes: string | null }[] | null;
  const createdText = (Array.isArray(internalRow) ? internalRow[0] : internalRow)?.internal_notes ?? null;
  const notes = popoverNotes({
    createdText,
    orderCreatedAt: woRes.data.created_at as string,
    internal: (internalRes.data ?? []) as NoteRow[],
    shared: (sharedRes.data ?? []) as NoteRow[],
    me: profile.id,
  });
  return NextResponse.json(notes, { headers: { "Cache-Control": "no-store" } });
}
