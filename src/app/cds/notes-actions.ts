"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-wo/ActionForm";
import { isUuid } from "@/components/cds-wo/util";
import { requireCds } from "@/lib/auth";
import { noteBody } from "@/lib/notes";
import { createClient } from "@/lib/supabase/server";

/**
 * Edits a CDS-only internal note (work_order_internal_notes). Only its author may, through
 * public.cds_edit_internal_note, which stores the edit time and logs the old and new text in
 * the change log. Notes the shop sees are never edited.
 */
export async function editInternalNote(woId: string, noteId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCds();
  if (!isUuid(woId) || !isUuid(noteId)) return { error: "Note not found." };
  const note = noteBody(formData.get("body"));
  if ("error" in note) return { error: note.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cds_edit_internal_note", { p_note: noteId, p_body: note.body });
  if (error) return { error: error.message };
  revalidatePath(`/cds/work-orders/${woId}`);
  return { ok: "Note saved.", at: Date.now() };
}
