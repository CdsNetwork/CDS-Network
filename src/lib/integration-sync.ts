import type { SupabaseClient } from "@supabase/supabase-js";

export type SyncRow = {
  system: string;
  entity: string;
  entity_id?: string | null;
  external_id?: string | null;
  direction: string;
  status: string;
  error?: string | null;
};

/**
 * Writes one integration_sync audit row. The row is a record of what happened, never a
 * reason to fail the user's action, so a refused or failed insert is written to the server
 * log and reported as false instead of thrown.
 */
export async function recordSync(db: Pick<SupabaseClient, "from">, row: SyncRow): Promise<boolean> {
  try {
    const { error } = await db.from("integration_sync").insert(row);
    if (!error) return true;
    console.error(`integration_sync insert failed (${row.system}/${row.entity} ${row.entity_id ?? ""} ${row.status}): ${error.message}`);
  } catch (e) {
    console.error(`integration_sync insert failed (${row.system}/${row.entity} ${row.entity_id ?? ""} ${row.status}): ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}
