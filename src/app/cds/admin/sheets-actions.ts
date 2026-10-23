"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/cds-admin/ActionForm";
import { requireCds } from "@/lib/auth";
import { sheetsConfig } from "@/lib/sheets/config";
import { runSheetsBackup } from "@/lib/sheets/run";
import { createAdminClient } from "@/lib/supabase/admin";

/** "Back up now": a full backup run (every work order), the same as the cron's daily one. */
export async function backupNow(): Promise<ActionState> {
  await requireCds();
  if (!sheetsConfig()) return { error: "The Google Sheets backup is not configured on this server." };
  const run = await runSheetsBackup(createAdminClient(), { full: true });
  revalidatePath("/cds/admin");
  if (!run) return { error: "The Google Sheets backup is not configured on this server." };
  if (run.status !== "ok") return { error: `The backup failed: ${run.error}` };
  return { ok: true, message: `Backed up ${run.rows} work orders (${run.added} added, ${run.updated} updated).` };
}
